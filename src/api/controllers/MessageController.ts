import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceProviderRegistry } from '../../application/InstanceProviderRegistry.js';
import type { CommunicationProvider, SendResult } from '../../core/interfaces/CommunicationProvider.js';
import type { InstanceRepository } from '../../core/interfaces/InstanceRepository.js';

type MessageType =
  | 'text'
  | 'image'
  | 'sticker'
  | 'audio'
  | 'video'
  | 'document'
  | 'location'
  | 'buttons'
  | 'list'
  | 'carousel'
  | 'reaction';

/**
 * Uma única rota (`POST /v1/instances/:id/messages/:type`) para todos os tipos de mensagem —
 * evita 10 controllers quase idênticos. O `switch` abaixo despacha por *tipo de mensagem*,
 * não por provider (o provider já foi resolvido polimorficamente antes de chegar aqui).
 */
export class MessageController {
  constructor(
    private readonly instanceRepository: InstanceRepository,
    private readonly instanceProviderRegistry: InstanceProviderRegistry,
  ) {}

  send = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id, type } = request.params as { id: string; type: MessageType };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return;
    }

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    const body = (request.body ?? {}) as Record<string, unknown>;

    reply.send(await this.dispatch(provider, id, type, body));
  };

  getMedia = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return;
    }

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    reply.send(await provider.getMediaBase64(id, messageId));
  };

  private dispatch(
    provider: CommunicationProvider,
    id: string,
    type: MessageType,
    body: Record<string, unknown>,
  ): Promise<SendResult> {
    switch (type) {
      case 'text':
        return provider.sendText(id, body['to'] as string, body['text'] as string, body['options'] as never);
      case 'image':
        return provider.sendImage(id, body['to'] as string, body['mediaUrl'] as string, body['caption'] as string | undefined);
      case 'sticker':
        return provider.sendSticker(id, body['to'] as string, body['mediaUrl'] as string);
      case 'audio':
        return provider.sendAudio(id, body['to'] as string, body['mediaUrl'] as string);
      case 'video':
        return provider.sendVideo(id, body['to'] as string, body['mediaUrl'] as string, body['caption'] as string | undefined);
      case 'document':
        return provider.sendDocument(id, body['to'] as string, body['mediaUrl'] as string, body['fileName'] as string);
      case 'location':
        return provider.sendLocation(
          id,
          body['to'] as string,
          body['latitude'] as number,
          body['longitude'] as number,
          body['name'] as string | undefined,
          body['address'] as string | undefined,
        );
      case 'buttons':
        return provider.sendButtons(id, body['to'] as string, body['content'] as never);
      case 'list':
        return provider.sendList(id, body['to'] as string, body['content'] as never);
      case 'carousel':
        return provider.sendCarousel(id, body['to'] as string, body['content'] as never, body['providerOptions'] as never);
      case 'reaction':
        return provider.sendReaction(id, body['to'] as string, body['messageId'] as string, body['emoji'] as string);
      default: {
        const exhaustive: never = type;
        throw new Error(`Tipo de mensagem desconhecido: "${String(exhaustive)}".`);
      }
    }
  }
}
