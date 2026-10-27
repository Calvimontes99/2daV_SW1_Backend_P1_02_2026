/**
 * Persistencia de la colaboración: chat de la sala, historial de cambios con autor, propuestas
 * de la IA, última visita de cada integrante y la memoria (resumen) de la IA.
 * Las tablas se crean solas al arrancar (también en una base que ya tenía datos).
 */
import pool from '../config/db.js';

export const asegurarTablasColaboracion = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "MensajesSala" (
            id SERIAL PRIMARY KEY,
            sala_id INT NOT NULL REFERENCES "Salas"(id) ON DELETE CASCADE,
            autor_id INT REFERENCES "Users"(id) ON DELETE SET NULL,
            autor_nombre VARCHAR(255),
            tipo VARCHAR(20) NOT NULL,
            texto TEXT NOT NULL,
            datos JSONB,
            creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS mensajes_sala_idx ON "MensajesSala" (sala_id, id);

        CREATE TABLE IF NOT EXISTS "CambiosSala" (
            id SERIAL PRIMARY KEY,
            sala_id INT NOT NULL REFERENCES "Salas"(id) ON DELETE CASCADE,
            autor_id INT REFERENCES "Users"(id) ON DELETE SET NULL,
            autor_nombre VARCHAR(255),
            es_ia BOOLEAN NOT NULL DEFAULT false,
            pedido_por VARCHAR(255),
            aprobado_por VARCHAR(255),
            operacion VARCHAR(30) NOT NULL,
            elemento_id VARCHAR(120),
            elemento_nombre VARCHAR(255),
            resumen TEXT NOT NULL,
            antes JSONB,
            despues JSONB,
            creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS cambios_sala_idx ON "CambiosSala" (sala_id, id);

        CREATE TABLE IF NOT EXISTS "PropuestasSala" (
            id SERIAL PRIMARY KEY,
            sala_id INT NOT NULL REFERENCES "Salas"(id) ON DELETE CASCADE,
            mensaje_id INT REFERENCES "MensajesSala"(id) ON DELETE SET NULL,
            pedido_por_id INT REFERENCES "Users"(id) ON DELETE SET NULL,
            pedido_por_nombre VARCHAR(255),
            instruccion TEXT,
            estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            operaciones JSONB NOT NULL,
            resumen JSONB NOT NULL,
            decidido_por_id INT REFERENCES "Users"(id) ON DELETE SET NULL,
            decidido_por_nombre VARCHAR(255),
            decidido_en TIMESTAMPTZ,
            motivo TEXT,
            creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS propuestas_sala_idx ON "PropuestasSala" (sala_id, estado);

        CREATE TABLE IF NOT EXISTS "VisitasSala" (
            user_id INT NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
            sala_id INT NOT NULL REFERENCES "Salas"(id) ON DELETE CASCADE,
            ultima_visita TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, sala_id)
        );

        CREATE TABLE IF NOT EXISTS "DispositivosUsuario" (
            token TEXT PRIMARY KEY,
            user_id INT NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
            plataforma VARCHAR(20),
            actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- Una propuesta que quedó "aplicando" por un corte del servidor vuelve a estar pendiente
        UPDATE "PropuestasSala" SET estado = 'pendiente' WHERE estado = 'aplicando';
        -- Expulsados por el dueño: su invitación vieja ya no los readmite (solo una invitación nueva por correo)
        CREATE TABLE IF NOT EXISTS "ExpulsionesSala" (
            sala_id INT NOT NULL REFERENCES "Salas"(id) ON DELETE CASCADE,
            user_id INT NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
            creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (sala_id, user_id)
        );
        -- Versión del diagrama guardado: una escritura atrasada no puede pisar una más nueva
        ALTER TABLE "Salas" ADD COLUMN IF NOT EXISTS version_guardada BIGINT NOT NULL DEFAULT 0;
        -- Cuándo cambiaron los datos de un mensaje (p. ej. la IA le agrega el id de su propuesta):
        -- al reconectar se recuperan también esas actualizaciones, no solo los mensajes nuevos
        ALTER TABLE "MensajesSala" ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ;
        -- Dos chats por sala: 'equipo' (entre personas) e 'ia' (pedidos a la IA, sus respuestas y
        -- avisos de propuestas). Cada uno se pagina aparte: uno muy activo no tapa al otro.
        ALTER TABLE "MensajesSala" ADD COLUMN IF NOT EXISTS canal VARCHAR(10);
        UPDATE "MensajesSala" SET canal = CASE
            WHEN tipo <> 'usuario' OR (datos->>'paraIA') = 'true' THEN 'ia' ELSE 'equipo' END
         WHERE canal IS NULL;
        CREATE INDEX IF NOT EXISTS mensajes_sala_canal_idx ON "MensajesSala" (sala_id, canal, id);
        -- Mensajes escritos sin conexión: el id que les dio el navegador evita guardarlos dos veces
        -- si se reenvían (se cortó la conexión justo al subirlos, otra pestaña, etc.)
        ALTER TABLE "MensajesSala" ADD COLUMN IF NOT EXISTS id_local VARCHAR(80);
        CREATE UNIQUE INDEX IF NOT EXISTS mensajes_sala_id_local_idx ON "MensajesSala" (sala_id, id_local) WHERE id_local IS NOT NULL;
        ALTER TABLE "Salas" ADD COLUMN IF NOT EXISTS resumen_ia TEXT;
        -- Ids de las tandas de operaciones que ya incluye el diagrama guardado (para no repetirlas)
        ALTER TABLE "Salas" ADD COLUMN IF NOT EXISTS lotes_aplicados JSONB;
        ALTER TABLE "Salas" ADD COLUMN IF NOT EXISTS resumen_ia_hasta INT NOT NULL DEFAULT 0;
    `);
};

// ─────────────── mensajes ───────────────

const mensajeDeFila = (f) => ({
    id: f.id,
    salaId: f.sala_id,
    autorId: f.autor_id,
    autorNombre: f.autor_nombre,
    tipo: f.tipo,
    canal: f.canal || canalDe(f.tipo, f.datos),
    ...(f.id_local ? { idLocal: f.id_local } : {}),
    texto: f.texto,
    datos: f.datos || null,
    creadoEn: f.creado_en,
});

/** Chat al que va un mensaje: lo de la IA, los avisos y lo que se le pide a la IA van al chat 'ia'. */
export const CANALES = ['equipo', 'ia'];
export const canalDe = (tipo, datos) => (tipo !== 'usuario' || datos?.paraIA ? 'ia' : 'equipo');

export const guardarMensaje = async ({ salaId, autorId = null, autorNombre = null, tipo, texto, datos = null }) => {
    const { rows } = await pool.query(
        `INSERT INTO "MensajesSala" (sala_id, autor_id, autor_nombre, tipo, texto, datos, canal)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [salaId, autorId, autorNombre, tipo, texto, datos ? JSON.stringify(datos) : null, canalDe(tipo, datos)],
    );
    return mensajeDeFila(rows[0]);
};

export const actualizarDatosMensaje = async (id, datos) => {
    const { rows } = await pool.query(
        `UPDATE "MensajesSala" SET datos = COALESCE(datos, '{}'::jsonb) || $2::jsonb, actualizado_en = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(datos)],
    );
    return rows[0] ? mensajeDeFila(rows[0]) : null;
};

/**
 * Guarda un mensaje escrito sin conexión. Si ese id local ya estaba (reenvío), no lo repite:
 * devuelve { mensaje, nuevo: false } con el que ya existía.
 */
export const importarMensaje = async ({ salaId, autorId = null, autorNombre = null, tipo, texto, datos = null, idLocal }) => {
    const { rows } = await pool.query(
        `INSERT INTO "MensajesSala" (sala_id, autor_id, autor_nombre, tipo, texto, datos, canal, id_local)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (sala_id, id_local) WHERE id_local IS NOT NULL DO NOTHING
         RETURNING *`,
        [salaId, autorId, autorNombre, tipo, texto, datos ? JSON.stringify(datos) : null, canalDe(tipo, datos), idLocal],
    );
    if (rows[0]) return { mensaje: mensajeDeFila(rows[0]), nuevo: true };
    const previo = await pool.query('SELECT * FROM "MensajesSala" WHERE sala_id = $1 AND id_local = $2', [salaId, idLocal]);
    return { mensaje: previo.rows[0] ? mensajeDeFila(previo.rows[0]) : null, nuevo: false };
};

/**
 * Los últimos mensajes en orden cronológico; con antesDe se pagina hacia atrás.
 * @param canal  'equipo' | 'ia' para uno de los dos chats; sin canal, los dos juntos
 */
export const listarMensajes = async (salaId, { limite = 60, antesDe = null, canal = null } = {}) => {
    const { rows } = await pool.query(
        `SELECT * FROM "MensajesSala" WHERE sala_id = $1 AND ($2::int IS NULL OR id < $2)
            AND ($4::text IS NULL OR canal = $4)
         ORDER BY id DESC LIMIT $3`,
        [salaId, antesDe, Math.min(Number(limite) || 60, 200), CANALES.includes(canal) ? canal : null],
    );
    return rows.reverse().map(mensajeDeFila);
};

/** Mensajes posteriores a un id (para completar lo que faltó durante una desconexión). */
export const mensajesDesde = async (salaId, desdeId, limite = 200, actualizadosDesde = null) => {
    // actualizadosDesde (marca del servidor): también los mensajes viejos que cambiaron después
    const { rows } = await pool.query(
        `SELECT * FROM "MensajesSala" WHERE sala_id = $1
            AND (id > $2 OR ($4::timestamptz IS NOT NULL AND actualizado_en > $4))
         ORDER BY id LIMIT $3`,
        [salaId, desdeId, limite, actualizadosDesde],
    );
    return rows.map(mensajeDeFila);
};

export const contarMensajesDesde = async (salaId, desdeId) => {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n, max(id) AS ultimo FROM "MensajesSala" WHERE sala_id = $1 AND id > $2`,
        [salaId, desdeId],
    );
    return { cantidad: rows[0].n, ultimoId: rows[0].ultimo };
};

/** Hora del servidor de base de datos (la "marca" que el cliente devuelve al reconectar). */
export const marcaDeTiempo = async () => {
    const { rows } = await pool.query('SELECT clock_timestamp() AS marca');
    return rows[0].marca;
};

// ─────────────── historial de cambios ───────────────

const cambioDeFila = (f) => ({
    id: f.id,
    salaId: f.sala_id,
    autorId: f.autor_id,
    autorNombre: f.autor_nombre,
    esIA: f.es_ia,
    pedidoPor: f.pedido_por,
    aprobadoPor: f.aprobado_por,
    operacion: f.operacion,
    elementoId: f.elemento_id,
    elementoNombre: f.elemento_nombre,
    resumen: f.resumen,
    creadoEn: f.creado_en,
});

/** @param db  conexión de una transacción en curso (o el pool) */
export const guardarCambio = async (c, db = pool) => {
    const { rows } = await db.query(
        `INSERT INTO "CambiosSala" (sala_id, autor_id, autor_nombre, es_ia, pedido_por, aprobado_por,
            operacion, elemento_id, elemento_nombre, resumen, antes, despues)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [c.salaId, c.autorId || null, c.autorNombre || null, !!c.esIA, c.pedidoPor || null, c.aprobadoPor || null,
            c.operacion, c.elementoId || null, c.elementoNombre || null, c.resumen,
            c.antes ? JSON.stringify(c.antes) : null, c.despues ? JSON.stringify(c.despues) : null],
    );
    return cambioDeFila(rows[0]);
};

export const listarCambios = async (salaId, { limite = 100, autor = null, desde = null, despuesDe = null } = {}) => {
    // despuesDe (id): los posteriores, del más viejo al más nuevo (completar tras reconectar)
    const { rows } = await pool.query(
        `SELECT * FROM "CambiosSala" WHERE sala_id = $1
            AND ($2::text IS NULL OR autor_nombre ILIKE $2 OR (es_ia AND $2 ILIKE 'ia'))
            AND ($3::timestamptz IS NULL OR creado_en > $3)
            AND ($5::int IS NULL OR id > $5)
         ORDER BY ${despuesDe ? 'id ASC' : 'id DESC'} LIMIT $4`,
        [salaId, autor, desde, Math.min(Number(limite) || 100, autor ? 2000 : 500), despuesDe],
    );
    return (despuesDe ? rows : rows.reverse()).map(cambioDeFila);
};

// ─────────────── propuestas de la IA ───────────────

const propuestaDeFila = (f) => ({
    id: f.id,
    salaId: f.sala_id,
    mensajeId: f.mensaje_id,
    pedidoPorId: f.pedido_por_id,
    pedidoPorNombre: f.pedido_por_nombre,
    instruccion: f.instruccion,
    estado: f.estado,
    operaciones: f.operaciones,
    resumen: f.resumen,
    decididoPorNombre: f.decidido_por_nombre,
    decididoEn: f.decidido_en,
    motivo: f.motivo,
    creadoEn: f.creado_en,
});

export const guardarPropuesta = async (p) => {
    const { rows } = await pool.query(
        `INSERT INTO "PropuestasSala" (sala_id, mensaje_id, pedido_por_id, pedido_por_nombre, instruccion, operaciones, resumen)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [p.salaId, p.mensajeId || null, p.pedidoPorId || null, p.pedidoPorNombre || null, p.instruccion || null,
            JSON.stringify(p.operaciones), JSON.stringify(p.resumen)],
    );
    return propuestaDeFila(rows[0]);
};

export const obtenerPropuesta = async (id) => {
    const { rows } = await pool.query(`SELECT * FROM "PropuestasSala" WHERE id = $1`, [id]);
    return rows[0] ? propuestaDeFila(rows[0]) : null;
};

/**
 * Cierra una propuesta solo si sigue pendiente: si dos personas deciden a la vez, gana la primera.
 * @returns la propuesta actualizada, o null si ya estaba decidida
 */
export const cerrarPropuesta = async (id, { estado, decididoPorId = null, decididoPorNombre = null, motivo = null }) => {
    const { rows } = await pool.query(
        `UPDATE "PropuestasSala" SET estado = $2, decidido_por_id = $3, decidido_por_nombre = $4,
            decidido_en = now(), motivo = $5
         WHERE id = $1 AND estado = 'pendiente' RETURNING *`,
        [id, estado, decididoPorId, decididoPorNombre, motivo],
    );
    return rows[0] ? propuestaDeFila(rows[0]) : null;
};

/** Marca la propuesta como "aplicando" solo si sigue pendiente. @returns true si la reservó */
export const reservarPropuesta = async (id) => {
    const { rowCount } = await pool.query(
        `UPDATE "PropuestasSala" SET estado = 'aplicando' WHERE id = $1 AND estado = 'pendiente'`, [id],
    );
    return rowCount === 1;
};

/** Resultado final de una propuesta reservada: aceptada (se aplicó) o desactualizada (no se aplicó). */
/** @param db  conexión de una transacción en curso (o el pool) */
export const finalizarPropuesta = async (id, { estado, decididoPorId = null, decididoPorNombre = null, motivo = null }, db = pool) => {
    const { rows } = await db.query(
        `UPDATE "PropuestasSala" SET estado = $2, decidido_por_id = $3, decidido_por_nombre = $4,
            decidido_en = now(), motivo = $5
         WHERE id = $1 AND estado = 'aplicando' RETURNING *`,
        [id, estado, decididoPorId, decididoPorNombre, motivo],
    );
    return rows[0] ? propuestaDeFila(rows[0]) : null;
};

/** Una propuesta que no se pudo guardar vuelve a estar pendiente (nada se aplicó). */
export const reabrirPropuesta = async (id) => {
    await pool.query(`UPDATE "PropuestasSala" SET estado = 'pendiente' WHERE id = $1 AND estado = 'aplicando'`, [id]);
};

export const listarPropuestas = async (salaId, { soloPendientes = false, limite = 30 } = {}) => {
    const { rows } = await pool.query(
        `SELECT * FROM "PropuestasSala" WHERE sala_id = $1 AND (NOT $2 OR estado = 'pendiente')
         ORDER BY id DESC LIMIT $3`,
        [salaId, soloPendientes, limite],
    );
    return rows.reverse().map(propuestaDeFila);
};

// ─────────────── visitas y memoria ───────────────

export const leerUltimaVisita = async (userId, salaId) => {
    const { rows } = await pool.query(
        `SELECT ultima_visita FROM "VisitasSala" WHERE user_id = $1 AND sala_id = $2`, [userId, salaId],
    );
    return rows[0]?.ultima_visita || null;
};

export const marcarVisita = async (userId, salaId) => {
    await pool.query(
        `INSERT INTO "VisitasSala" (user_id, sala_id, ultima_visita) VALUES ($1, $2, now())
         ON CONFLICT (user_id, sala_id) DO UPDATE SET ultima_visita = now()`,
        [userId, salaId],
    );
};

export const leerMemoria = async (salaId) => {
    const { rows } = await pool.query(
        `SELECT title, resumen_ia, resumen_ia_hasta FROM "Salas" WHERE id = $1`, [salaId],
    );
    return rows[0]
        ? { titulo: rows[0].title, resumen: rows[0].resumen_ia || '', hasta: rows[0].resumen_ia_hasta || 0 }
        : { titulo: '', resumen: '', hasta: 0 };
};

export const guardarMemoria = async (salaId, resumen, hasta) => {
    await pool.query(`UPDATE "Salas" SET resumen_ia = $2, resumen_ia_hasta = $3 WHERE id = $1`, [salaId, resumen, hasta]);
};

export const nombreDeUsuario = async (userId) => {
    if (!userId) return null;
    const { rows } = await pool.query(`SELECT name, email FROM "Users" WHERE id = $1`, [userId]);
    return rows[0] ? { nombre: rows[0].name, email: rows[0].email } : null;
};

/** Integrantes de la sala: dueño e invitados. */
export const integrantesDeSala = async (salaId) => {
    const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email FROM "Users" u JOIN "Salas" s ON s.userId = u.id WHERE s.id = $1
         UNION
         SELECT u.id, u.name, u.email FROM "Users" u JOIN "Usersala" us ON us.userId = u.id WHERE us.salas_id = $1`,
        [salaId],
    );
    return rows;
};

/** Salas del usuario (propias e invitadas) con su última actividad, para la app móvil. */
export const salasDeUsuario = async (userId) => {
    const { rows } = await pool.query(
        `SELECT s.id, s.title, s.description, s.userid AS dueno_id, u.name AS dueno, s.updatedat,
                (s.userid = $1) AS propia,
                GREATEST(s.updatedat,
                    (SELECT max(creado_en) FROM "MensajesSala" m WHERE m.sala_id = s.id),
                    (SELECT max(creado_en) FROM "CambiosSala" c WHERE c.sala_id = s.id)) AS ultima_actividad,
                (SELECT count(*)::int FROM "PropuestasSala" p WHERE p.sala_id = s.id AND p.estado = 'pendiente') AS propuestas_pendientes
         FROM "Salas" s JOIN "Users" u ON u.id = s.userid
         WHERE s.eliminar = false
           AND (s.userid = $1 OR EXISTS (SELECT 1 FROM "Usersala" us WHERE us.salas_id = s.id AND us.userid = $1))
         ORDER BY ultima_actividad DESC NULLS LAST`,
        [userId],
    );
    return rows.map((f) => ({
        id: f.id, titulo: f.title, descripcion: f.description, dueno: f.dueno, propia: f.propia,
        ultimaActividad: f.ultima_actividad, propuestasPendientes: f.propuestas_pendientes,
    }));
};

// ─────────────── expulsiones ───────────────

export const registrarExpulsion = async (salaId, userId) => {
    await pool.query(
        `INSERT INTO "ExpulsionesSala" (sala_id, user_id) VALUES ($1, $2) ON CONFLICT (sala_id, user_id) DO UPDATE SET creado_en = now()`,
        [salaId, userId],
    );
};

/** El dueño vuelve a invitar a alguien por correo: se levanta su expulsión. */
export const levantarExpulsion = async (salaId, userId) => {
    await pool.query(`DELETE FROM "ExpulsionesSala" WHERE sala_id = $1 AND user_id = $2`, [salaId, userId]);
};

export const estaExpulsado = async (salaId, userId) => {
    const { rowCount } = await pool.query(`SELECT 1 FROM "ExpulsionesSala" WHERE sala_id = $1 AND user_id = $2`, [salaId, userId]);
    return rowCount > 0;
};

// ─────────────── dispositivos (notificaciones push) ───────────────

export const registrarDispositivo = async (userId, token, plataforma = 'android') => {
    await pool.query(
        `INSERT INTO "DispositivosUsuario" (token, user_id, plataforma, actualizado_en) VALUES ($1, $2, $3, now())
         ON CONFLICT (token) DO UPDATE SET user_id = $2, plataforma = $3, actualizado_en = now()`,
        [token, userId, plataforma],
    );
};

export const quitarDispositivo = async (token) => {
    await pool.query(`DELETE FROM "DispositivosUsuario" WHERE token = $1`, [token]);
};

export const tokensDeUsuarios = async (userIds) => {
    if (!userIds.length) return [];
    const { rows } = await pool.query(
        `SELECT token, user_id FROM "DispositivosUsuario" WHERE user_id = ANY($1::int[])`, [userIds],
    );
    return rows;
};
