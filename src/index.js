import 'dotenv/config';
import app from './config/app.js';
import pool from './config/db.js';
import { inicializarBaseDatos } from './config/inicializarBaseDatos.js';
import { asegurarUsuariosPrueba } from './config/usuariosPrueba.js';
import { asegurarTablerosPrueba } from './config/tablerosPrueba.js';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import http from 'http';
import errorHandler from './middlewares/catchedAsync.js';
import { updateSala, getSalaById } from './models/sala.model.js';
import { createUserSala, getUsersBySala } from './models/usersala.model.js';
import { FRONTEND_URLS, TOKEN_SECRET } from './config.js';
import { asegurarTablasColaboracion, estaExpulsado, nombreDeUsuario } from './colaboracion/repositorio.js';
import { alRegistrarCambio, anunciarCambios, cerrarSala as cerrarHistorial, filasDeCambio, fijarBase, registrarVersion, tieneBase, vaciarTodo as vaciarHistorial } from './colaboracion/registroCambios.js';
import { crearAplicarAtomico, crearGuardarSala } from './colaboracion/aplicarAtomico.js';
import { crearFila } from './colaboracion/candado.js';
import { guardarCambio } from './colaboracion/repositorio.js';
import { configurarIA } from './colaboracion/iaSala.js';
import { darBienvenida, registrarEventosColaboracion, registrarSalida } from './colaboracion/socketsColaboracion.js';
import { limpiarElemento } from './colaboracion/diagramaSemantico.js';
import { aplicarOps, esOperacionValida, opsEntre } from './colaboracion/operacionesDiagrama.js';
import { invitacionValida } from './libs/invitaciones.js';
import { avisarCambio, avisarIntegrantes, configurarPush } from './colaboracion/notificacionesPush.js';

// Conecta y, si la base está vacía (primer despliegue), crea las tablas desde database.sql
const baseLista = inicializarBaseDatos()
    .then((creada) => console.log(creada ? 'DB connected: tablas creadas desde database.sql' : 'DB connected successfully'))
    // Chat de la sala, historial con autor, propuestas de la IA y memoria (se crean si faltan)
    .then(() => asegurarTablasColaboracion().catch(err => console.error('No se pudieron preparar las tablas de colaboración:', err.message)))
    // Cuentas y tableros de ejemplo (CLAVE_USUARIOS_PRUEBA vacía los desactiva); cada arranque
    // restaura los cinco tableros de ejemplo y deja intactos los demás de esas cuentas
    .then(() => asegurarUsuariosPrueba()
        .then(async (cuentas) => {
            if (!cuentas.length) return;
            console.log(`Cuentas de prueba listas: ${cuentas.map(c => c.email).join(', ')}`);
            const { restaurados, conservados } = await asegurarTablerosPrueba(cuentas[0].id, cuentas[1].id);
            console.log(`Tableros de ejemplo: ${restaurados} restaurados, ${conservados} propios conservados`);
        })
        .catch(err => console.error('No se pudieron preparar los datos de prueba:', err.message)))
    .catch(err => console.error("Error connecting to DB", err.stack));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: {
        origin: FRONTEND_URLS,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    }
});

// Socket.IO authentication middleware: validate JWT from cookie or auth payload
io.use((socket, next) => {
    try {
        const cookieHeader = socket.handshake.headers.cookie || '';
        let token = null;
        const match = cookieHeader.match(/(^|;\s*)token=([^;]+)/);
        if (match) token = decodeURIComponent(match[2]);
        // fallback to auth payload (for cross-origin or testing)
        if (!token && socket.handshake.auth && socket.handshake.auth.token) {
            token = socket.handshake.auth.token;
        }

        if (!token) {
            // Sin token no se permite la conexión: toda colaboración requiere sesión
            return next(new Error('Inicia sesión para editar tableros en tiempo real.'));
        }

        jwt.verify(token, TOKEN_SECRET, (err, decoded) => {
            if (err) {
                console.warn('Socket auth failed:', err.message);
                return next(new Error('Tu sesión expiró. Inicia sesión de nuevo para editar en tiempo real.'));
            }
            socket.user = decoded;
            return next();
        });
    } catch (err) {
        console.error('Socket auth middleware error', err);
        return next(new Error('Tu sesión expiró. Inicia sesión de nuevo para editar en tiempo real.'));
    }
});

app.set('io', io);
const salasActivas = new Map();
// Debounced save timers per sala to avoid excessive DB writes during rapid updates
const pendingSaveTimers = new Map();
const SAVE_DEBOUNCE_MS = parseInt(process.env.SAVE_DEBOUNCE_MS || '3000', 10);

/**
 * Guarda el estado en memoria de la sala unos segundos después del último cambio. No reenvía el
 * diagrama a los clientes: los cambios ya les llegaron como operaciones (reenviar el estado
 * guardado pisaba los cambios que un cliente todavía no había confirmado).
 */
const MAX_LOTES_SIN_SECUENCIA = 2000;
const MAX_OPS_POR_LOTE = 2000;

/**
 * Las tandas de la web se llaman "<cliente>:<número>" y cada cliente las envía en orden, de a una.
 * Basta recordar el último número aplicado de cada cliente (se guarda junto con el diagrama):
 * así el servidor reconoce para siempre una tanda vieja reenviada, sin una ventana que se olvide
 * después de muchas tandas. Los ids sin ese formato (clientes antiguos) usan una lista acotada.
 */
const partirIdLote = (id) => {
    const m = /^(.{1,80}):(\d{1,15})$/.exec(typeof id === 'string' ? id : '');
    return m ? { cliente: m[1], seq: Number(m[2]) } : null;
};
const loteYaAplicado = (sala, id) => {
    const partes = partirIdLote(id);
    return !!partes && (sala.secuencias.get(partes.cliente) ?? 0) >= partes.seq;
};
/**
 * Al entrar, el cliente pregunta por sus tandas pendientes. Las de la versión anterior (sin
 * número) se buscan en la lista que guardó el servidor viejo: si están, ya se aplicaron y el
 * cliente las descarta en lugar de renumerarlas y repetirlas.
 */
const idYaAplicado = (sala, id) => (partirIdLote(id) ? loteYaAplicado(sala, id) : sala.lotes.has(id));
/** Marca una tanda de operaciones como aplicada (para no repetirla si el cliente la reenvía). */
const recordarLote = (sala, id) => {
    if (!id) return;
    const partes = partirIdLote(id);
    if (partes) {
        if ((sala.secuencias.get(partes.cliente) ?? 0) < partes.seq) sala.secuencias.set(partes.cliente, partes.seq);
        return;
    }
    sala.lotes.add(id);
    if (sala.lotes.size > MAX_LOTES_SIN_SECUENCIA) sala.lotes.delete(sala.lotes.values().next().value);
};
const serializarLotes = (sala) => ({ secuencias: Object.fromEntries(sala.secuencias || []), lotes: [...(sala.lotes || [])] });
const leerLotes = (valor) => {
    if (Array.isArray(valor)) return { secuencias: new Map(), lotes: new Set(valor) };
    const secuencias = new Map(Object.entries(valor?.secuencias || {}).map(([k, v]) => [k, Number(v) || 0]));
    return { secuencias, lotes: new Set(Array.isArray(valor?.lotes) ? valor.lotes : []) };
};

/**
 * Mientras se guarda una propuesta aceptada la sala está bloqueada: lo que llegue espera su turno
 * y se aplica después, en el mismo orden.
 */
const enTurno = (sala, fn) => {
    if (sala && sala.bloqueada) {
        (sala.enEspera ||= []).push(fn);
        return;
    }
    fn();
};
const drenar = (salaId, sala) => {
    while (!sala.bloqueada && sala.enEspera && sala.enEspera.length) {
        const fn = sala.enEspera.shift();
        try { fn(); } catch (error) { console.error('Cambio en espera falló:', error); }
    }
};

/**
 * Todas las escrituras del diagrama de una sala van en FILA: autoguardado, "Guardar", salida del
 * último usuario, apagado y la transacción de una propuesta aceptada. Antes un autoguardado ya
 * iniciado podía esperar el bloqueo de la fila y escribir DESPUÉS del COMMIT de una propuesta,
 * con el diagrama viejo. Es una fila distinta de la de propuestas (conCandado): aceptar una
 * propuesta espera aquí su escritura.
 */
const escrituraEnTurno = crearFila();

/**
 * Escribe el diagrama de memoria con su versión: la base solo acepta una versión MAYOR que la
 * guardada, así ninguna escritura atrasada puede pisar una más nueva (colaboracion/aplicarAtomico.js).
 */
const guardarSalaAhora = crearGuardarSala({ pool, serializarLotes, escrituraEnTurno });

const programarGuardado = (salaIdNormalizado) => {
    const sala = salasActivas.get(salaIdNormalizado);
    if (!sala) return;
    sala.sucio = true;
    sala.version = (sala.version || 0) + 1;
    try {
        const existing = pendingSaveTimers.get(salaIdNormalizado);
        if (existing && existing.timeout) clearTimeout(existing.timeout);
        const timeout = setTimeout(async () => {
            try {
                await guardarSalaAhora(salaIdNormalizado, sala);
                pendingSaveTimers.delete(salaIdNormalizado);
                // Sala vacía que esperaba este guardado: ya se puede liberar
                liberarSiVacia(salaIdNormalizado, sala);
            } catch (saveErr) {
                console.error(`Debounced save failed for sala ${salaIdNormalizado}:`, saveErr);
            }
        }, SAVE_DEBOUNCE_MS);
        pendingSaveTimers.set(salaIdNormalizado, { timeout, ts: Date.now() });
    } catch (schedErr) {
        console.error('Error scheduling debounced save:', schedErr);
    }
};

// ───── Una sola carga por sala: nadie puede modificarla antes de que tenga su estado ─────
const cargandoSalas = new Map();

/**
 * Deja la sala en memoria (con su diagrama y las tandas ya aplicadas) y la devuelve. Si dos
 * personas entran a la vez, se carga una sola vez. Antes la sala se creaba vacía y el estado
 * llegaba después: una operación temprana podía aplicarse sobre un diagrama vacío.
 */
const activarSala = (salaId) => {
    const ya = salasActivas.get(salaId);
    if (ya) return Promise.resolve(ya);
    if (cargandoSalas.has(salaId)) return cargandoSalas.get(salaId);
    const carga = (async () => {
        const filas = await getSalaById(salaId);
        const fila = filas && filas[0];
        if (!fila) throw new Error('El tablero no existe o fue eliminado.');
        let estado = { nodes: [], edges: [] };
        try {
            const leido = fila.xml ? JSON.parse(fila.xml) : null;
            if (leido && typeof leido === 'object') estado = { nodes: leido.nodes || [], edges: leido.edges || [] };
        } catch { /* diagrama dañado: se empieza vacío */ }
        const { secuencias, lotes } = leerLotes(fila.lotes_aplicados);
        const sala = {
            usuarios: new Map(),
            ultimoEstado: estado,
            ultimaModificacion: null,
            secuencias,
            lotes,
            // La numeración de versiones sigue desde lo guardado (no vuelve a 0 tras un reinicio)
            version: Number(fila.version_guardada) || 0,
            sucio: false,
            bloqueada: false,
            enEspera: [],
        };
        salasActivas.set(salaId, sala);
        if (!tieneBase(salaId)) fijarBase(salaId, estado);
        return sala;
    })().finally(() => cargandoSalas.delete(salaId));
    cargandoSalas.set(salaId, carga);
    return carga;
};

/** Sin nadie conectado y sin nada por guardar, la sala sale de memoria. */
const liberarSiVacia = (salaId, sala) => {
    if (sala.usuarios.size === 0 && !sala.sucio && salasActivas.get(salaId) === sala && !pendingSaveTimers.has(salaId)) {
        salasActivas.delete(salaId);
        cerrarHistorial(salaId);
    }
};

/**
 * Quita el acceso en vivo: los sockets de ese usuario (o de todos, si userId es null) salen de la
 * sala y ya no pueden mandar cambios. Se usa al expulsar a alguien o al borrar el tablero.
 */
const revocarAcceso = async (salaId, userId = null, mensaje = 'Ya no tienes acceso a este tablero.') => {
    const id = parseInt(salaId, 10);
    const sockets = await io.in(`sala_${id}`).fetchSockets();
    const sala = salasActivas.get(id);
    for (const s of sockets) {
        if (userId !== null && parseInt(s.autor?.id ?? s.user?.id, 10) !== parseInt(userId, 10)) continue;
        s.emit('accesoRevocado', { salaId: id, mensaje });
        s.leave(`sala_${id}`);
        if (sala) sala.usuarios.delete(s.id);
        // El socket real (no la copia de fetchSockets) pierde la sala: sus eventos se rechazan
        const real = io.sockets.sockets.get(s.id);
        if (real) real.salaId = null;
    }
    if (sala) io.to(`sala_${id}`).emit('usuariosConectados', { usuarios: Array.from(sala.usuarios.values()) });
};
app.set('revocarAcceso', revocarAcceso);

// ───── Colaboración con la IA: el servidor conoce el diagrama actual y quién hace cada cambio ─────

/** Quién es el socket, según su token (no según lo que manda el cliente). */
const autorDelSocket = (socket) => socket.autor
    || (socket.user?.id ? { id: socket.user.id, nombre: socket.usuario?.name || socket.usuario?.email || 'Alguien' } : null);

const estadoGuardadoEnBase = async (salaId) => {
    const filas = await getSalaById(salaId);
    try {
        const estado = filas && filas[0] && filas[0].xml ? JSON.parse(filas[0].xml) : null;
        return estado && typeof estado === 'object' ? { nodes: estado.nodes || [], edges: estado.edges || [] } : { nodes: [], edges: [] };
    } catch {
        return { nodes: [], edges: [] };
    }
};

/** Diagrama actual: el de memoria si la sala está abierta, si no el guardado. */
const estadoActualDeSala = async (salaId) => {
    const sala = salasActivas.get(salaId);
    if (sala && sala.ultimoEstado) return { nodes: sala.ultimoEstado.nodes || [], edges: sala.ultimoEstado.edges || [] };
    return estadoGuardadoEnBase(salaId);
};

/**
 * Toda mutación aceptada del diagrama pasa por aquí: se aplica al estado en memoria, se anota en
 * el historial con su autor, se programa el guardado y se reenvía como operaciones a los demás.
 * Es síncrona: entre leer el estado y escribirlo no puede colarse otro cambio.
 * @param {import('socket.io').Socket|null} origen  quien la mandó (no se le reenvía); null: a todos
 * @returns {object[]} las operaciones aplicadas
 */
const mutarSala = (salaId, sala, ops, autor, origen = null, opcionesHistorial = {}) => {
    const validas = (ops || []).filter(esOperacionValida);
    if (!validas.length) return [];
    const anterior = sala.ultimoEstado && typeof sala.ultimoEstado === 'object'
        ? { nodes: sala.ultimoEstado.nodes || [], edges: sala.ultimoEstado.edges || [] }
        : { nodes: [], edges: [] };
    sala.ultimoEstado = aplicarOps(anterior, validas);
    sala.ultimaModificacion = Date.now();
    try {
        if (!tieneBase(salaId)) fijarBase(salaId, anterior);
        // sinHistorial: el historial ya se guardó en la misma transacción (propuestas de la IA)
        if (opcionesHistorial.sinHistorial) fijarBase(salaId, sala.ultimoEstado);
        else if (autor) registrarVersion(salaId, sala.ultimoEstado, autor, { nodos: true, aristas: true }, opcionesHistorial);
    } catch (err) {
        console.error('Historial: no se pudo comparar la versión', err.message);
    }
    programarGuardado(salaId);
    const envio = { salaId, ops: validas, autor: autor ? { id: autor.id ?? null, nombre: autor.nombre, esIA: !!autor.esIA } : null };
    if (origen) origen.to(`sala_${salaId}`).emit('operaciones', envio);
    else io.to(`sala_${salaId}`).emit('operaciones', envio);
    return validas;
};

/**
 * Reemplaza el diagrama por `estado` (cambios aprobados de la IA). La sala debe estar en memoria
 * (activarSala): es síncrono, sin esperas entre leer y escribir.
 */
const aplicarEstadoDeSala = (salaId, estado, autor) => {
    const sala = salasActivas.get(salaId);
    if (!sala) throw new Error('La sala no está cargada');
    const limpio = { nodes: (estado.nodes || []).map(limpiarElemento), edges: (estado.edges || []).map(limpiarElemento) };
    mutarSala(salaId, sala, opsEntre(sala.ultimoEstado || { nodes: [], edges: [] }, limpio), autor, null, { inmediato: true });
    return true;
};

/** Propuesta aceptada: diagrama + cierre + historial en una transacción (colaboracion/aplicarAtomico.js). */
const aplicarAtomico = crearAplicarAtomico({
    pool,
    guardarCambio,
    filasDeCambio,
    serializarLotes,
    drenar,
    escrituraEnTurno,
    alConfirmar: (salaId, sala, antes, despues, autor, cambiosGuardados, version) => {
        mutarSala(salaId, sala, opsEntre(antes, despues), autor, null, { sinHistorial: true });
        // La versión de memoria queda igual a la guardada por la transacción (o mayor)
        sala.version = Math.max(sala.version || 0, version);
        // La base ya tiene exactamente este estado: no hace falta otro guardado
        const pend = pendingSaveTimers.get(salaId);
        if (pend && pend.timeout) clearTimeout(pend.timeout);
        pendingSaveTimers.delete(salaId);
        sala.sucio = false;
        anunciarCambios(salaId, cambiosGuardados);
        liberarSiVacia(salaId, sala);
    },
});

/** El estado de la sala si está abierta (para aplicar propuestas sin esperas en medio). */
const estadoEnMemoria = (salaId) => {
    const sala = salasActivas.get(salaId);
    return sala && sala.ultimoEstado ? { nodes: sala.ultimoEstado.nodes || [], edges: sala.ultimoEstado.edges || [] } : null;
};

configurarIA({
    emitir: (salaId, evento, datos) => io.to(`sala_${salaId}`).emit(evento, datos),
    estadoActual: estadoActualDeSala,
    estadoEnMemoria,
    activarSala,
    // Aplica y guarda una propuesta aceptada de forma atómica (la sala se carga si estaba cerrada)
    aplicarYGuardar: async (salaId, opciones) => aplicarAtomico(salaId, await activarSala(salaId), {
        ...opciones,
        // Lo que se guarda va sin selección ni medidas (como todo el estado del servidor)
        calcular: (estado) => {
            const r = opciones.calcular(estado);
            return r.estado ? { ...r, estado: { nodes: r.estado.nodes.map(limpiarElemento), edges: r.estado.edges.map(limpiarElemento) } } : r;
        },
    }),
    // Agregar elementos sin reemplazar el diagrama (las notas con ideas de la IA)
    aplicarOpsSala: async (salaId, ops, autor) => {
        const sala = await activarSala(salaId);
        mutarSala(salaId, sala, ops, autor, null, { inmediato: true });
        liberarSiVacia(salaId, sala);
    },
    conectados: (salaId) => {
        const sala = salasActivas.get(salaId);
        if (!sala) return [];
        return [...new Set([...sala.usuarios.values()].map(u => u.autorNombre || u.name || u.email).filter(Boolean))];
    },
    aplicarEstado: aplicarEstadoDeSala,
    // Quien no tiene la sala abierta recibe la respuesta de la IA en el teléfono
    alResponder: (salaId, respuesta) => {
        if (respuesta?.texto) avisarIntegrantes(salaId, '🤖 IA', respuesta.texto);
    },
});
alRegistrarCambio((salaId, cambio) => {
    io.to(`sala_${salaId}`).emit('historial:nuevo', cambio);
    avisarCambio(salaId, cambio);
});
configurarPush({
    conectadosIds: (salaId) => {
        const sala = salasActivas.get(salaId);
        return new Set(sala ? [...sala.usuarios.values()].map(u => parseInt(u.id, 10)).filter(n => !isNaN(n)) : []);
    },
});

/** Convierte un evento antiguo (cambioInstantaneo / operacionElemento) en operaciones. */
const opsDeEventoAntiguo = (sala, elemento) => {
    const estado = sala.ultimoEstado || { nodes: [], edges: [] };
    const una = (el) => {
        if (!el || typeof el !== 'object' || typeof el.id !== 'string') return null;
        if (el.source && el.target) {
            const previa = (estado.edges || []).find(e => e.id === el.id);
            return { op: 'ponerArista', arista: { ...(previa || {}), ...el, data: { ...(previa?.data || {}), ...(el.data || {}) } } };
        }
        const previo = (estado.nodes || []).find(n => n.id === el.id);
        if (el.position || previo) {
            return { op: 'ponerNodo', nodo: { ...(previo || {}), ...el, data: { ...(previo?.data || {}), ...(el.data || {}) } } };
        }
        // Solo datos de una relación: { id, data }
        const arista = (estado.edges || []).find(e => e.id === el.id);
        return arista ? { op: 'ponerArista', arista: { ...arista, data: { ...(arista.data || {}), ...(el.data || {}) } } } : null;
    };
    return (Array.isArray(elemento) ? elemento : [elemento]).map(una).filter(Boolean);
};

io.on('connection', (socket) => {
    // console.log('🟢 Nuevo cliente conectado:', socket.id);
    // Accept optional ack callback: socket.emit('unirseSala', payload, (ack) => { ... })
    socket.on('unirseSala', async ({ salaId, usuario, invitacion, lotes } = {}, callback) => {
        // Responde el rechazo por el ack (si lo hay) y por el evento de error de siempre
        const rechazar = (message, motivo = 'error') => {
            socket.emit('errorSincronizacion', { message, motivo });
            if (typeof callback === 'function') callback({ ok: false, motivo, mensaje: message });
        };
        try {
            const salaIdNormalizado = parseInt(salaId, 10);
            if (isNaN(salaIdNormalizado)) {
                console.error(`❌ salaId inválido recibido: ${salaId} (tipo: ${typeof salaId})`);
                rechazar('La dirección del tablero no es válida. Ábrelo desde la lista de tableros.');
                return;
            }

            // Control de acceso: el socket debe pertenecer a un usuario autenticado
            const authUserId = socket.user && socket.user.id;
            if (!authUserId) {
                rechazar('Inicia sesión para abrir este tablero.', 'sin-sesion');
                return;
            }

            // La sala debe existir; verificar membresía (dueño o invitado en Usersala)
            const salaRows = await getSalaById(salaIdNormalizado);
            if (!salaRows || salaRows.length === 0) {
                rechazar('El tablero no existe o fue eliminado.', 'no-existe');
                return;
            }
            const ownerId = salaRows[0].userId || salaRows[0].userid || salaRows[0].user_id;
            const esDueno = parseInt(ownerId, 10) === parseInt(authUserId, 10);
            if (!esDueno) {
                const miembros = await getUsersBySala(salaIdNormalizado);
                const esMiembro = miembros.some(m => parseInt(m.userid ?? m.userId, 10) === parseInt(authUserId, 10));
                if (!esMiembro) {
                    // Un expulsado no vuelve con su enlace viejo: hace falta que el dueño lo invite de nuevo
                    if (await estaExpulsado(salaIdNormalizado, authUserId)) {
                        rechazar('El creador del tablero te quitó el acceso. Pídele que te invite de nuevo por correo.', 'expulsado');
                        return;
                    }
                    // Solo con una invitación firmada (enlace o QR generado por el dueño) se
                    // acepta a alguien nuevo; saber el número de la sala no alcanza
                    if (!invitacionValida(invitacion, salaIdNormalizado)) {
                        rechazar('No tienes acceso a este tablero. Pide a su creador que te invite con el enlace o el QR.', 'sin-acceso');
                        return;
                    }
                    try {
                        await createUserSala(authUserId, salaIdNormalizado);
                    } catch (joinErr) {
                        // Duplicado por carrera: ignorar; cualquier otro error sí bloquea
                        if (!(joinErr.message && joinErr.message.includes('ya está asociado'))) {
                            console.error('unirseSala: no se pudo registrar la membresía', joinErr);
                            rechazar('No se pudo verificar tu acceso al tablero. Recarga la página e intenta de nuevo.');
                            return;
                        }
                    }
                }
            }

            const sala = await activarSala(salaIdNormalizado);
            socket.join(`sala_${salaIdNormalizado}`);
            socket.salaId = salaIdNormalizado;
            // Resolve usuario: prefer payload, then socket.user (from JWT), fill defaults
            const resolvedUsuario = Object.assign({ id: null, name: 'guest', email: null }, socket.user || {}, usuario || {});
            socket.usuario = resolvedUsuario;
            // El autor de los cambios y mensajes sale del token y de la base, no del cliente
            const datosAutor = await nombreDeUsuario(authUserId).catch(() => null);
            socket.autor = { id: parseInt(authUserId, 10), nombre: datosAutor?.nombre || datosAutor?.email || resolvedUsuario.name || 'Alguien' };
            resolvedUsuario.autorNombre = socket.autor.nombre;
            sala.usuarios.set(socket.id, { ...resolvedUsuario, socketId: socket.id });
            const clientesSocketIO = io.sockets.adapter.rooms.get(`sala_${salaIdNormalizado}`);
                    // console.log(`Room state for sala ${salaIdNormalizado}:`);
                    // console.log(`   users in memory: ${sala.usuarios.size}`);
                    // console.log(`   socket.io clients in room: ${clientesSocketIO ? clientesSocketIO.size : 0}`);

                    // sala.usuarios.forEach((user, socketId) => {
                    //     console.log(`      - ${user.name} (${user.isInvited ? 'invited' : 'owner'}) - socket: ${socketId}`);
                    // });
            
            socket.to(`sala_${salaIdNormalizado}`).emit('usuarioUnido', { 
                usuario: resolvedUsuario,
                timestamp: Date.now()
            });

            // If client provided an ack callback, confirm join
                try {
                if (typeof callback === 'function') {
                    callback({ ok: true, salaId: salaIdNormalizado, usuarios: Array.from(sala.usuarios.values()) });
                }
            } catch (err) {
                // console.warn('unirseSala: ack callback failed', err);
            }
            
            try {
                // console.log(`Socket: loading state for sala ID: ${salaIdNormalizado}`);
                // Tandas que este cliente tenía pendientes y que el servidor ya aplicó (no repetirlas)
                const aplicados = (Array.isArray(lotes) ? lotes : []).filter(id => typeof id === 'string' && idYaAplicado(sala, id));
                socket.emit('estadoInicial', { state: sala.ultimoEstado, aplicados });
            } catch (error) {
                console.error(`❌ Socket: Error cargando estado para sala ${salaIdNormalizado}:`, error);
                socket.emit('estadoInicial', { state: null });
            }
            const usuariosConectados = Array.from(sala.usuarios.values());
            // A toda la sala (incluido el que entra) para que todos reconstruyan la lista
            io.to(`sala_${salaIdNormalizado}`).emit('usuariosConectados', { usuarios: usuariosConectados });
            // Lo que pasó desde su última visita (solo para quien entra)
            darBienvenida(socket, salaIdNormalizado, socket.autor);
            // usuariosConectados.forEach(u => {
            //     console.log(`      - ${u.name} (${u.isInvited ? 'INVITADO/USERSALA' : 'PROPIETARIO'})`);
            // });
        } catch (error) {
            console.error('Error al unirse a la sala:', error);
            socket.emit('errorSincronizacion', { message: 'No se pudo abrir el tablero en tiempo real. Recarga la página.' });
        }
    });
    
    socket.on('cambioInstantaneo', (data) => {
        try {
            // Prefer usuario from payload, fallback to socket.usuario (set on unirseSala) or socket.user (JWT)
            const { salaId, usuario: payloadUsuario, tipo, elemento, timestamp } = data || {};
            const usuario = payloadUsuario || socket.usuario || socket.user || null;
            if (!salaId || !tipo || !elemento) {
                console.warn('❌ Datos insuficientes en cambioInstantaneo:', { salaId, tipo, elemento: elemento?.id });
                socket.emit('errorSincronizacion', { message: 'No se pudo compartir tu último cambio. Si los demás no lo ven, recarga la página.' });
                return;
            }
            // Accept usuario if it has at least a name, email or id
            if (!usuario || !(usuario.name || usuario.email || usuario.id)) {
                console.warn('❌ Usuario inválido en cambioInstantaneo - payloadUsuario:', payloadUsuario, ' socket.usuario:', socket.usuario, ' socket.user:', socket.user);
                socket.emit('errorSincronizacion', { message: 'Tu sesión no es válida para editar este tablero. Inicia sesión de nuevo.' });
                return;
            }
            const salaIdNormalizado = parseInt(salaId, 10);
            if (!socket.salaId || parseInt(socket.salaId, 10) !== salaIdNormalizado) {
                socket.emit('errorSincronizacion', { message: 'Se perdió la conexión con el tablero. Recarga la página para volver a conectarte.' });
                return;
            }
            const salaActiva = salasActivas.get(salaIdNormalizado);
            if (salaActiva) enTurno(salaActiva, () => mutarSala(salaIdNormalizado, salaActiva, opsDeEventoAntiguo(salaActiva, elemento), autorDelSocket(socket), socket));
        } catch (error) {
            console.error('❌ Error en cambio instantáneo:', error);
            socket.emit('errorSincronizacion', { message: 'No se pudo compartir tu último cambio con los demás. Revisa tu conexión.' });
        }
    });
    
            socket.on('operacionElemento', (data) => {
        try {
            const { salaId, usuario: payloadUsuario2, operacion, elemento } = data || {};
            const usuario2 = payloadUsuario2 || socket.usuario || socket.user || null;
            if (!salaId || !operacion || !elemento) {
                console.warn('❌ Datos insuficientes en operacionElemento:', { salaId, operacion, elemento: elemento?.id });
                socket.emit('errorSincronizacion', { message: 'No se pudo compartir tu último cambio. Si los demás no lo ven, recarga la página.' });
                return;
            }
            if (!usuario2 || !(usuario2.name || usuario2.email || usuario2.id)) {
                console.warn('❌ Usuario inválido en operacionElemento - payloadUsuario2:', payloadUsuario2, ' socket.usuario:', socket.usuario, ' socket.user:', socket.user);
                socket.emit('errorSincronizacion', { message: 'Tu sesión no es válida para editar este tablero. Inicia sesión de nuevo.' });
                return;
            }
            const salaIdNormalizado = parseInt(salaId, 10);
            if (!socket.salaId || parseInt(socket.salaId, 10) !== salaIdNormalizado) {
                socket.emit('errorSincronizacion', { message: 'Se perdió la conexión con el tablero. Recarga la página para volver a conectarte.' });
                return;
            }
            const sala = salasActivas.get(salaIdNormalizado);
            if (sala) enTurno(sala, () => mutarSala(salaIdNormalizado, sala, opsDeEventoAntiguo(sala, elemento), autorDelSocket(socket), socket));
        } catch (error) {
            console.error('❌ Error en operación elemento:', error);
            socket.emit('errorSincronizacion', { message: 'No se pudo compartir tu último cambio con los demás. Revisa tu conexión.' });
        }
    });

    socket.on('actualizarDiagrama', (data) => {
        try {
            const { salaId, usuario, action } = data;
            const salaIdNormalizado = parseInt(salaId, 10);
            const socketSalaNormalizada = parseInt(socket.salaId, 10);
            if (!socket.salaId || socketSalaNormalizada !== salaIdNormalizado) {
                socket.emit('errorSincronizacion', { message: 'Se perdió la conexión con el tablero. Recarga la página para volver a conectarte.' });
                return;
            }
            const sala = salasActivas.get(salaIdNormalizado);
            // Estado completo (clientes antiguos): se convierte en las operaciones que lo diferencian
            if (sala && action === 'fullState' && data?.data?.state) {
                enTurno(sala, () => mutarSala(salaIdNormalizado, sala, opsEntre(sala.ultimoEstado || { nodes: [], edges: [] }, data.data.state), autorDelSocket(socket), socket));
            }
        } catch (error) {
            console.error('❌ Error actualizando diagrama:', error);
            socket.emit('errorSincronizacion', { message: 'No se pudieron compartir tus cambios con los demás. Revisa tu conexión.' });
        }
    });

    socket.on('guardarEstado', async ({ salaId, estado }) => {
        try {
            // Normalizar y exigir que el socket esté unido a esa sala (igual que cambioInstantaneo)
            const salaIdNormalizado = parseInt(salaId, 10);
            if (isNaN(salaIdNormalizado) || parseInt(socket.salaId, 10) !== salaIdNormalizado) {
                socket.emit('errorSincronizacion', { message: 'Se perdió la conexión con el tablero. Recarga la página para volver a conectarte.' });
                return;
            }
            // "Guardar" escribe lo que el servidor ya tiene: con operaciones, el estado de memoria es
            // el bueno; aceptar la copia del cliente podía pisar cambios de otros
            const sala = salasActivas.get(salaIdNormalizado);
            if (sala && sala.ultimoEstado) {
                const pend = pendingSaveTimers.get(salaIdNormalizado);
                if (pend && pend.timeout) clearTimeout(pend.timeout);
                pendingSaveTimers.delete(salaIdNormalizado);
                await guardarSalaAhora(salaIdNormalizado, sala);
            } else if (estado && typeof estado === 'object') {
                await updateSala(salaIdNormalizado, undefined, JSON.stringify(estado), undefined, null);
            }
            socket.emit('estadoGuardado', { success: true });
        } catch (error) {
            console.error(`❌ Socket: Error guardando estado para sala ${salaId}:`, error);
            socket.emit('errorSincronizacion', { message: 'No se pudo guardar el tablero. Tus cambios siguen en pantalla: intenta guardar de nuevo en unos segundos.' });
        }
    });

    socket.on('solicitarEstado', async ({ salaId }) => {
        try {
            const salaIdNormalizado = parseInt(salaId, 10);
            if (isNaN(salaIdNormalizado) || parseInt(socket.salaId, 10) !== salaIdNormalizado) {
                socket.emit('errorSincronizacion', { message: 'Se perdió la conexión con el tablero. Recarga la página para volver a conectarte.' });
                return;
            }
            const sala = await activarSala(salaIdNormalizado);
            socket.emit('estadoInicial', { state: sala.ultimoEstado, aplicados: [] });
        } catch (error) {
            console.error('Error cargando estado inicial:', error);
            socket.emit('errorSincronizacion', { message: 'No se pudo cargar el contenido del tablero. Recarga la página.' });
        }
    });

    // Operaciones explícitas sobre el diagrama (web y móvil)
    // Una tanda { id, ops }: si el id ya se aplicó (reenvío tras reconectar o recargar) no se repite
    socket.on('operaciones', ({ salaId, ops, lote } = {}, ack) => {
        const responder = (r) => { if (typeof ack === 'function') ack(r); };
        try {
            const salaIdNormalizado = parseInt(salaId, 10);
            if (isNaN(salaIdNormalizado) || parseInt(socket.salaId, 10) !== salaIdNormalizado) {
                return responder({ ok: false, mensaje: 'Se perdió la conexión con el tablero.', sinAcceso: !socket.salaId });
            }
            const sala = salasActivas.get(salaIdNormalizado);
            const lista = lote && Array.isArray(lote.ops) ? lote.ops : ops;
            const idLote = lote && typeof lote.id === 'string' ? lote.id.slice(0, 120) : null;
            if (!sala || !Array.isArray(lista)) return responder({ ok: false, mensaje: 'Operaciones no válidas.' });
            // Sin "<cliente>:<número>" no hay forma segura de reconocer un reenvío (podría pisar
            // trabajo posterior): esas tandas de clientes antiguos se rechazan; al recargar la
            // página, el cliente nuevo las renumera y las reenvía
            if (!partirIdLote(idLote)) {
                return responder({ ok: false, formato: true, mensaje: 'Formato de tanda antiguo: recarga la página para sincronizar.' });
            }
            // Una tanda más grande que el máximo se rechaza ENTERA: nunca se confirma algo recortado
            if (lista.length > MAX_OPS_POR_LOTE) {
                return responder({ ok: false, demasiadas: true, mensaje: `La tanda tiene más de ${MAX_OPS_POR_LOTE} operaciones.` });
            }
            // Cambios que hizo la IA local del navegador sin conexión: el historial los anota como
            // de la IA, pedidos por quien la usó
            const autorSocket = autorDelSocket(socket);
            const autor = lote?.origen === 'ia-local' && autorSocket
                ? { ...autorSocket, nombre: 'IA local', esIA: true, pedidoPor: autorSocket.nombre }
                : autorSocket;
            return enTurno(sala, () => {
                if (idLote && loteYaAplicado(sala, idLote)) return responder({ ok: true, duplicado: true });
                const aplicadas = mutarSala(salaIdNormalizado, sala, lista, autor, socket);
                recordarLote(sala, idLote);
                return responder({ ok: true, aplicadas: aplicadas.length, version: sala.version || 0 });
            });
        } catch (error) {
            console.error('❌ Error aplicando operaciones:', error);
            return responder({ ok: false, mensaje: 'No se pudieron aplicar tus cambios.' });
        }
    });

    // Chat de la sala con la IA compartida, propuestas e historial
    registrarEventosColaboracion(io, socket, () => autorDelSocket(socket));

    socket.on('disconnect', async () => {
        try {
            // console.log('Socket client disconnected:', socket.id);
            if (socket.salaId && socket.autor) registrarSalida(socket.autor, socket.salaId);
            if (socket.salaId && socket.usuario) {
                const sala = salasActivas.get(socket.salaId);
                if (sala) {
                    sala.usuarios.delete(socket.id);
                    socket.to(`sala_${socket.salaId}`).emit('usuarioSalio', {
                        usuarioId: socket.usuario.id
                    });
                    // Reemitir la lista completa para que los clientes la reconstruyan
                    socket.to(`sala_${socket.salaId}`).emit('usuariosConectados', {
                        usuarios: Array.from(sala.usuarios.values())
                    });
                    if (sala.usuarios.size === 0) {
                        // Antes de descartar la sala en memoria, atender un guardado
                        // pendiente: si el debounce no llego a dispararse, persistimos
                        // ya mismo para no perder los ultimos cambios (y evitamos que
                        // el timer huerfano escriba encima de estado mas nuevo despues).
                        const salaId = socket.salaId;
                        const pend = pendingSaveTimers.get(salaId);
                        if (pend && pend.timeout) clearTimeout(pend.timeout);
                        pendingSaveTimers.delete(salaId);
                        if ((pend || sala.sucio) && sala.ultimoEstado) {
                            try {
                                await guardarSalaAhora(salaId, sala);
                            } catch (saveErr) {
                                console.error(`Error persistiendo estado final de sala ${salaId}:`, saveErr);
                                sala.sucio = true;
                            }
                        }
                        // Mientras se guardaba pudo entrar alguien: entonces la sala sigue viva
                        if (sala.usuarios.size === 0 && salasActivas.get(salaId) === sala) {
                            if (sala.sucio) programarGuardado(salaId);
                            else liberarSiVacia(salaId, sala);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error en desconexión:', error);
        }
    });
});

app.use((req, res, next) => {
    res.status(404).json({ error: true, message: 'La dirección solicitada no existe.' });
});
app.use(errorHandler);

const PORT = process.env.PORT || 8083;
// Se escucha cuando la base respondió (o falló: /apis/health/db lo informa)
baseLista.finally(() => {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});

// Al redesplegar o apagar, la plataforma envía SIGTERM: los tableros con guardado
// pendiente (debounce) se escriben antes de salir para no perder los últimos cambios.
let cerrando = false;
const cerrar = async (senal) => {
    if (cerrando) return;
    cerrando = true;
    console.log(`${senal}: guardando tableros pendientes y cerrando...`);
    setTimeout(() => process.exit(1), 10000).unref();
    for (const pend of pendingSaveTimers.values()) clearTimeout(pend.timeout);
    await Promise.allSettled([...salasActivas.entries()]
        .filter(([salaId, sala]) => sala.sucio || pendingSaveTimers.has(salaId))
        .map(([salaId, sala]) => guardarSalaAhora(salaId, sala)));
    pendingSaveTimers.clear();
    vaciarHistorial();
    await new Promise(r => setTimeout(r, 300));
    io.close();
    await pool.end().catch(() => {});
    process.exit(0);
};
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));
