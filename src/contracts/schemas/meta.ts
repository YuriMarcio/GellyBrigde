import { z } from 'zod';

// ============================================================================
// Validação em runtime das restrições rígidas da Meta Cloud API — usadas só pelo
// MetaCloudApiProvider antes de chamar a API, para falhar com um erro claro em vez de
// deixar a Meta rejeitar com um 400 genérico.
// ============================================================================

export const MetaButtonsContentSchema = z.object({
  title: z.string().optional(),
  body: z.string().max(1024),
  footer: z.string().max(60).optional(),
  imageUrl: z.string().optional(),
  buttons: z
    .array(
      z.object({
        id: z.string().max(256),
        displayText: z.string().max(20),
      }),
    )
    .min(1)
    .max(3, 'Meta Cloud API aceita no máximo 3 botões por mensagem'),
});

export const MetaListContentSchema = z.object({
  title: z.string().max(60),
  description: z.string().max(4096),
  buttonText: z.string().max(20),
  footer: z.string().max(60).optional(),
  sections: z
    .array(
      z.object({
        title: z.string().max(24),
        rows: z
          .array(
            z.object({
              rowId: z.string().max(200),
              title: z.string().max(24),
              description: z.string().max(72).optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(10, 'Meta Cloud API aceita no máximo 10 seções'),
}).superRefine((value, ctx) => {
  const totalRows = value.sections.reduce((sum, section) => sum + section.rows.length, 0);
  if (totalRows > 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Meta Cloud API aceita no máximo 10 linhas no total, somando todas as seções',
    });
  }
});

/** Botão único de link (interactive `cta_url`) — o equivalente Meta de um botão `url` solto. */
export const MetaCtaUrlContentSchema = z.object({
  title: z.string().max(60).optional(),
  body: z.string().max(1024),
  footer: z.string().max(60).optional(),
  imageUrl: z.string().optional(),
  button: z.object({
    displayText: z.string().min(1).max(20),
    url: z.string().url(),
  }),
});

export const MetaTemplateContentSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_]+$/, 'name do template: só minúsculas, números e "_"'),
  languageCode: z.string().min(2),
});
