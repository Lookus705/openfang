import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.OPENFANG_SUPABASE_DATABASE_URL;
if (!databaseUrl) throw new Error("OPENFANG_SUPABASE_DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
const server = new McpServer({ name: "openfang-driver-operations", version: "1.0.0" });

const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const driverId = z.string().uuid();

async function requireDriver(userId) {
  const result = await pool.query(
    "SELECT id, nombre FROM public.usuarios WHERE id = $1 AND rol = 'driver' AND estado = 'active'",
    [userId],
  );
  if (result.rowCount !== 1) throw new Error("El usuario no es un chofer activo");
  return result.rows[0];
}

async function requireOpenShift(userId, shiftId) {
  await requireDriver(userId);
  const result = await pool.query(
    `SELECT j.id, j.user_id, j.vehiculo_id, j.placa_vehiculo, j.estado, j.km_inicio, j.salida_at
       FROM public.jornadas_chofer j
      WHERE j.id = $1 AND j.user_id = $2 AND j.estado IN ('abierta', 'en_ruta')`,
    [shiftId, userId],
  );
  if (result.rowCount !== 1) throw new Error("La jornada no pertenece al chofer o ya esta cerrada");
  return result.rows[0];
}

function databaseError(error) {
  if (error?.code === "23505") return new Error("Ya existe una jornada abierta para este chofer o camion");
  return error;
}

server.registerTool("start_shift", {
  description: "Inicia una jornada declarando el camion y kilometraje. Valida que el camion este activo y libre.",
  inputSchema: { user_id: driverId, vehicle_plate: z.string().min(2), odometer_km: z.number().nonnegative() },
}, async ({ user_id, vehicle_plate, odometer_km }) => {
  await requireDriver(user_id);
  const vehicle = await pool.query(
    "SELECT id, placa FROM public.vehiculos WHERE lower(placa) = lower($1) AND activo = true",
    [vehicle_plate.trim()],
  );
  if (vehicle.rowCount !== 1) throw new Error("El camion no existe o no esta activo");
  try {
    const result = await pool.query(
      `INSERT INTO public.jornadas_chofer (user_id, vehiculo_id, placa_vehiculo, km_inicio)
       VALUES ($1, $2, $3, $4) RETURNING id, placa_vehiculo, km_inicio, iniciada_at, estado`,
      [user_id, vehicle.rows[0].id, vehicle.rows[0].placa, odometer_km],
    );
    return textResult({ shift: result.rows[0] });
  } catch (error) { throw databaseError(error); }
});

server.registerTool("get_active_shift", {
  description: "Consulta la jornada abierta del chofer con su camion, cargas y ultimos eventos.",
  inputSchema: { user_id: driverId },
}, async ({ user_id }) => {
  await requireDriver(user_id);
  const shift = await pool.query(
    `SELECT id, placa_vehiculo, estado, km_inicio, salida_at, iniciada_at
       FROM public.jornadas_chofer WHERE user_id = $1 AND estado IN ('abierta', 'en_ruta')
       ORDER BY iniciada_at DESC LIMIT 1`, [user_id]);
  if (!shift.rowCount) return textResult({ shift: null, loads: [], temperatures: [], deliveries: [] });
  const id = shift.rows[0].id;
  const [loads, temperatures, deliveries] = await Promise.all([
    pool.query("SELECT id, numero_factura, cargado_por, condicion_producto, created_at FROM public.cargas_jornada WHERE jornada_id = $1 ORDER BY created_at", [id]),
    pool.query("SELECT destino, evento, temperatura_c, reportado_at FROM public.controles_temperatura WHERE jornada_id = $1 ORDER BY reportado_at DESC LIMIT 10", [id]),
    pool.query("SELECT destino, estado, motivo_rechazo, llegada_at FROM public.entregas_jornada WHERE jornada_id = $1 ORDER BY llegada_at DESC LIMIT 10", [id]),
  ]);
  return textResult({ shift: shift.rows[0], loads: loads.rows, temperatures: temperatures.rows, deliveries: deliveries.rows });
});

server.registerTool("add_load_invoice", {
  description: "Registra una factura cargada en la jornada y quien realizo la carga.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), invoice_number: z.string().min(1), loaded_by: z.string().min(1), product_condition: z.enum(["ambient", "frio", "congelado", "mixto"]) },
}, async ({ user_id, shift_id, invoice_number, loaded_by, product_condition }) => {
  await requireOpenShift(user_id, shift_id);
  const invoice = await pool.query("SELECT id FROM public.facturas WHERE numero = $1 LIMIT 1", [invoice_number]);
  try {
    const result = await pool.query(
      `INSERT INTO public.cargas_jornada (jornada_id, factura_id, numero_factura, cargado_por, condicion_producto)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, numero_factura, condicion_producto, created_at`,
      [shift_id, invoice.rows[0]?.id ?? null, invoice_number, loaded_by, product_condition],
    );
    return textResult({ load: result.rows[0] });
  } catch (error) { throw databaseError(error); }
});

server.registerTool("record_departure", {
  description: "Registra la hora de salida y la temperatura inicial del camion.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), temperature_c: z.number().min(-40).max(40), departed_at: z.string().datetime().optional() },
}, async ({ user_id, shift_id, temperature_c, departed_at }) => {
  await requireOpenShift(user_id, shift_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const time = departed_at ?? new Date().toISOString();
    await client.query("UPDATE public.jornadas_chofer SET estado = 'en_ruta', salida_at = $1 WHERE id = $2", [time, shift_id]);
    const temp = await client.query(
      "INSERT INTO public.controles_temperatura (jornada_id, evento, temperatura_c, reportado_at) VALUES ($1, 'salida', $2, $3) RETURNING id, temperatura_c, reportado_at",
      [shift_id, temperature_c, time],
    );
    await client.query("COMMIT");
    return textResult({ departure: { shift_id, departed_at: time, temperature: temp.rows[0] } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

server.registerTool("record_arrival_temperature", {
  description: "Registra llegada a un destino y la temperatura del camion en ese momento.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), destination: z.string().min(1), temperature_c: z.number().min(-40).max(40), arrived_at: z.string().datetime().optional() },
}, async ({ user_id, shift_id, destination, temperature_c, arrived_at }) => {
  await requireOpenShift(user_id, shift_id);
  const result = await pool.query(
    "INSERT INTO public.controles_temperatura (jornada_id, destino, evento, temperatura_c, reportado_at) VALUES ($1, $2, 'llegada', $3, $4) RETURNING id, destino, temperatura_c, reportado_at",
    [shift_id, destination, temperature_c, arrived_at ?? new Date().toISOString()],
  );
  return textResult({ temperature_check: result.rows[0] });
});

server.registerTool("record_delivery", {
  description: "Registra una entrega completada, parcial o rechazada en un destino.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), destination: z.string().min(1), status: z.enum(["entregada", "parcial", "rechazada"]), invoice_number: z.string().min(1).optional(), rejection_reason: z.string().min(1).optional() },
}, async ({ user_id, shift_id, destination, status, invoice_number, rejection_reason }) => {
  await requireOpenShift(user_id, shift_id);
  if (status === "rechazada" && !rejection_reason) throw new Error("Una entrega rechazada requiere el motivo");
  const load = invoice_number ? await pool.query("SELECT id FROM public.cargas_jornada WHERE jornada_id = $1 AND numero_factura = $2", [shift_id, invoice_number]) : { rows: [] };
  const result = await pool.query(
    "INSERT INTO public.entregas_jornada (jornada_id, carga_id, destino, estado, motivo_rechazo, resuelta_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, destino, estado, motivo_rechazo, llegada_at",
    [shift_id, load.rows[0]?.id ?? null, destination, status, rejection_reason ?? null, status === "rechazada" ? null : new Date().toISOString()],
  );
  return textResult({ delivery: result.rows[0] });
});

server.registerTool("report_incident", {
  description: "Registra una incidencia de camion, ruta o entrega. Las criticas deben escalarse al Supervisor o CEO.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), category: z.enum(["camion", "ruta", "entrega"]), description: z.string().min(5), priority: z.enum(["baja", "media", "alta", "critica"]).default("media"), destination: z.string().optional(), invoice_number: z.string().optional() },
}, async ({ user_id, shift_id, category, description, priority, destination, invoice_number }) => {
  const shift = await requireOpenShift(user_id, shift_id);
  const driver = await pool.query("SELECT chofer_id FROM public.usuarios WHERE id = $1", [user_id]);
  const result = await pool.query(
    `INSERT INTO public.incidencias (chofer_id, tipo, descripcion, prioridad, jornada_id, vehiculo_id, user_id, destino, numero_factura)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, tipo, prioridad, estado, created_at`,
    [driver.rows[0]?.chofer_id ?? null, category, description, priority, shift_id, shift.vehiculo_id, user_id, destination ?? null, invoice_number ?? null],
  );
  return textResult({ incident: result.rows[0], escalation_required: priority === "alta" || priority === "critica" });
});

server.registerTool("record_refuel", {
  description: "Registra un repostaje con kilometraje, litros, importe y estacion opcional.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), odometer_km: z.number().nonnegative(), liters: z.number().positive(), amount: z.number().nonnegative().optional(), station: z.string().optional() },
}, async ({ user_id, shift_id, odometer_km, liters, amount, station }) => {
  const shift = await requireOpenShift(user_id, shift_id);
  if (odometer_km < Number(shift.km_inicio)) throw new Error("El kilometraje no puede ser menor que el inicial");
  const result = await pool.query(
    "INSERT INTO public.repostajes (jornada_id, vehiculo_id, km, litros, importe, estacion) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, km, litros, importe, repostado_at",
    [shift_id, shift.vehiculo_id, odometer_km, liters, amount ?? null, station ?? null],
  );
  return textResult({ refuel: result.rows[0] });
});

server.registerTool("close_shift", {
  description: "Cierra la jornada con kilometraje final y temperatura final del camion.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), odometer_km: z.number().nonnegative(), temperature_c: z.number().min(-40).max(40), finished_at: z.string().datetime().optional() },
}, async ({ user_id, shift_id, odometer_km, temperature_c, finished_at }) => {
  const shift = await requireOpenShift(user_id, shift_id);
  if (odometer_km < Number(shift.km_inicio)) throw new Error("El kilometraje final no puede ser menor que el inicial");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const time = finished_at ?? new Date().toISOString();
    await client.query("UPDATE public.jornadas_chofer SET estado = 'cerrada', km_fin = $1, finalizada_at = $2 WHERE id = $3", [odometer_km, time, shift_id]);
    await client.query("INSERT INTO public.controles_temperatura (jornada_id, evento, temperatura_c, reportado_at) VALUES ($1, 'cierre', $2, $3)", [shift_id, temperature_c, time]);
    await client.query("COMMIT");
    return textResult({ shift_id, status: "cerrada", odometer_km, finished_at: time });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

server.registerTool("get_delivery_instructions", {
  description: "Consulta el cliente fiscal, alias comercial, ubicaciones e instrucciones aprobadas para una factura o cliente.",
  inputSchema: { user_id: driverId, invoice_number: z.string().min(1).optional(), client_id: z.string().uuid().optional() },
}, async ({ user_id, invoice_number, client_id }) => {
  await requireDriver(user_id);
  if (!invoice_number && !client_id) throw new Error("Indica factura o cliente");
  const client = client_id ? await pool.query("SELECT id, nombre, empresa FROM public.clientes WHERE id = $1", [client_id]) : await pool.query(
    "SELECT c.id, c.nombre, c.empresa FROM public.facturas f JOIN public.clientes c ON c.id = f.cliente_id WHERE f.numero = $1 LIMIT 1", [invoice_number]);
  if (!client.rowCount) throw new Error("No se encontro el cliente de la factura");
  const id = client.rows[0].id;
  const [aliases, locations, instructions] = await Promise.all([
    pool.query("SELECT alias FROM public.cliente_aliases WHERE cliente_id = $1 ORDER BY alias", [id]),
    pool.query("SELECT id, nombre, direccion, contacto FROM public.ubicaciones_entrega WHERE cliente_id = $1 AND activo ORDER BY nombre", [id]),
    pool.query("SELECT tipo, contenido, prioridad, expira_at FROM public.instrucciones_entrega WHERE cliente_id = $1 AND estado = 'aprobada' AND (expira_at IS NULL OR expira_at > now()) ORDER BY prioridad DESC, created_at DESC", [id]),
  ]);
  return textResult({ client: client.rows[0], aliases: aliases.rows, locations: locations.rows, instructions: instructions.rows });
});

server.registerTool("propose_delivery_note", {
  description: "Propone una nota operativa de cliente o ubicacion. Queda pendiente hasta aprobacion de un responsable.",
  inputSchema: { user_id: driverId, shift_id: z.string().uuid(), client_id: z.string().uuid(), location_id: z.string().uuid().optional(), note_type: z.enum(["horario", "acceso", "recepcion", "temperatura", "general"]), content: z.string().min(5), priority: z.enum(["baja", "media", "alta"]).default("media") },
}, async ({ user_id, shift_id, client_id, location_id, note_type, content, priority }) => {
  await requireOpenShift(user_id, shift_id);
  const location = location_id ? await pool.query("SELECT id FROM public.ubicaciones_entrega WHERE id = $1 AND cliente_id = $2 AND activo", [location_id, client_id]) : { rowCount: 1 };
  if (!location.rowCount) throw new Error("La ubicacion no pertenece al cliente o no esta activa");
  const result = await pool.query(
    "INSERT INTO public.instrucciones_entrega (cliente_id, ubicacion_id, tipo, contenido, prioridad, creado_por_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, estado, tipo, created_at",
    [client_id, location_id ?? null, note_type, content, priority, user_id]);
  return textResult({ note: result.rows[0], message: "Nota enviada para aprobacion" });
});

await server.connect(new StdioServerTransport());
