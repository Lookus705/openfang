import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.OPENFANG_SUPABASE_DATABASE_URL;
if (!databaseUrl) throw new Error("OPENFANG_SUPABASE_DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
const server = new McpServer({ name: "openfang-orchestrator", version: "1.0.0" });
const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

async function getFallbackRoute() {
  const result = await pool.query(
    "SELECT agente_destino FROM public.rutas_agente WHERE rol = 'unverified_customer' AND activo = true",
  );
  return result.rows[0]?.agente_destino ?? "Cliente generico";
}

server.registerTool("resolve_sender", {
  description: "Consulta el remitente de WhatsApp o Telegram y devuelve solamente su estado de registro, rol y agente de destino. No permite SQL ni cambios de datos.",
  inputSchema: {
    channel: z.enum(["whatsapp", "telegram"]),
    external_id: z.string().min(1).max(200),
  },
}, async ({ channel, external_id }) => {
  const contact = await pool.query(
    `SELECT
       c.usuario_id,
       c.verificado_at,
       c.activo AS contacto_activo,
       u.nombre,
       u.rol,
       u.estado AS usuario_estado,
       r.agente_destino
     FROM public.contactos_canal c
     LEFT JOIN public.usuarios u ON u.id = c.usuario_id
     LEFT JOIN public.rutas_agente r ON r.rol = u.rol AND r.activo = true
     WHERE c.canal = $1 AND c.external_id = $2
     LIMIT 1`,
    [channel, external_id.trim()],
  );

  const fallbackAgent = await getFallbackRoute();
  const row = contact.rows[0];
  const verified = Boolean(
    row?.usuario_id && row?.contacto_activo && row?.verificado_at && row?.usuario_estado === "active",
  );

  if (!verified) {
    return textResult({
      registered: Boolean(row?.usuario_id),
      verified: false,
      role: "unverified_customer",
      target_agent: fallbackAgent,
    });
  }

  return textResult({
    registered: true,
    verified: true,
    user_id: row.usuario_id,
    name: row.nombre,
    role: row.rol,
    target_agent: row.agente_destino ?? fallbackAgent,
  });
});

await server.connect(new StdioServerTransport());
