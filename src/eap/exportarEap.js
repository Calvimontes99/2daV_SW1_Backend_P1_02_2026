/**
 * Exportación a Enterprise Architect (.EAP) con el diagrama dibujado en el lienzo.
 *
 * Un .EAP es una base Jet 3 (Access 97). No existe una librería que escriba ese formato fuera de
 * Windows, así que se usa el motor de Windows: preparar-plan.mjs calcula las filas que EA 13 guarda
 * al dibujar a mano y escribir-eap.ps1 las inserta por ODBC (driver de Access de 32 bits, incluido
 * en Windows) en una copia de la plantilla vacía. El resultado se abrió y comparó fila por fila con
 * proyectos hechos en EA 13.5.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import archiver from 'archiver';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { especificacionDesdeTablero } from './especificacionDesdeTablero.js';

const CARPETA = path.dirname(fileURLToPath(import.meta.url));
const PLANTILLA = path.join(CARPETA, 'plantilla-vacia.eap');
const PREPARAR = path.join(CARPETA, 'scripts', 'preparar-plan.mjs');
const ESCRIBIR = path.join(CARPETA, 'scripts', 'escribir-eap.ps1');
const LIMITE_MS = 120000;

const ejecutar = (programa, argumentos) => new Promise((resolve, reject) => {
    execFile(programa, argumentos, { timeout: LIMITE_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
            if (error) {
                const detalle = `${stdout || ''}\n${stderr || ''}`.trim();
                return reject(Object.assign(error, { detalle }));
            }
            resolve(stdout);
        });
});

/**
 * ¿Este servidor puede escribir .EAP? Solo Windows trae el driver ODBC de Access. Fuera de Windows
 * (Render) se entrega el kit para generarlo en la PC del usuario. EAP_FORZAR_KIT=1 lo fuerza para probar.
 */
export const puedeEscribirEap = () => process.platform === 'win32' && process.env.EAP_FORZAR_KIT !== '1';

const errorDelUsuario = (mensaje, statusCode) => Object.assign(new Error(mensaje), { statusCode });

/**
 * Explicación para el usuario de por qué no salió el .EAP, con el motivo técnico al final:
 * antes se mostraba siempre el mismo mensaje genérico y no había forma de saber qué pasó.
 */
const motivoDelFallo = (error) => {
    const detalle = String(error.detalle || '');
    const lineaError = (detalle.match(/^ERROR.*$/m) || [])[0] || '';
    if (error.code === 'ENOENT') {
        return 'No se encontró PowerShell en este equipo, y hace falta para escribir el .EAP.';
    }
    if (error.killed || error.signal === 'SIGTERM') {
        return 'Escribir el .EAP tardó demasiado (más de 2 minutos) y se canceló. Cierra otros programas e intenta de nuevo.';
    }
    if (/IM002|driver|controlador/i.test(detalle) && !/no se pudo abrir/i.test(lineaError)) {
        return 'Windows no tiene el driver ODBC de Access de 32 bits ("Microsoft Access Driver (*.mdb)"), que hace falta para escribir el .EAP.';
    }
    if (/no se pudo abrir/i.test(lineaError)) {
        return `No se pudo abrir la copia de la plantilla con el motor de Access. ${lineaError.replace(/^ERROR:\s*/, '')}`;
    }
    if (/ExecutionPolicy|no está habilitada la ejecución|running scripts is disabled/i.test(detalle)) {
        return 'Windows bloqueó la ejecución del script que escribe el .EAP (directiva de ejecución de PowerShell).';
    }
    const motivo = lineaError.replace(/^ERROR:?\s*/, '')
        || detalle.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
        || error.message;
    return `No se pudo generar el archivo de Enterprise Architect. Motivo: ${String(motivo).slice(0, 300)}`;
};

/** Especificación y plan de filas del tablero (esto corre en cualquier sistema, también en Linux). */
const prepararPlan = async (tablero, titulo, carpeta) => {
    const especificacion = especificacionDesdeTablero(tablero, titulo);
    const archivoSpec = path.join(carpeta, 'especificacion.json');
    const archivoPlan = path.join(carpeta, 'plan.json');
    await writeFile(archivoSpec, JSON.stringify(especificacion), 'utf8');
    await ejecutar(process.execPath, [PREPARAR, archivoSpec, archivoPlan]);
    return archivoPlan;
};

const lineasBat = (nombre) => [
    '@echo off',
    'title Generar el proyecto de Enterprise Architect',
    'cd /d "%~dp0"',
    'echo ================================================================',
    `echo  Generando ${nombre}.eap para Enterprise Architect`,
    'echo ================================================================',
    'echo.',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0escribir-eap.ps1" -Plan "%~dp0plan.json" -Base "%~dp0plantilla-vacia.eap" -Salida "%~dp0${nombre}.eap" -Sobrescribir`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo No se pudo generar el archivo. Revisa el mensaje de arriba.',
    '  echo Si Enterprise Architect tiene abierto un archivo con el mismo nombre, cierralo y vuelve a intentar.',
    ') else (',
    '  echo.',
    `  echo Listo: ${nombre}.eap quedo en esta carpeta. Abrelo en Enterprise Architect con Open Project.`,
    `  explorer /select,"%~dp0${nombre}.eap"`,
    ')',
    'echo.',
    'pause',
    '',
].join('\r\n');

const leeme = (nombre) => [
    'GENERAR EL PROYECTO DE ENTERPRISE ARCHITECT (.EAP)',
    '==================================================',
    '',
    'Este servidor no puede escribir archivos .EAP (usan el motor de Access de Windows),',
    'así que te entrega todo listo para generarlo en tu computadora:',
    '',
    '  1. Descomprime este ZIP en una carpeta (clic derecho → Extraer todo).',
    '  2. Doble clic en GENERAR_EAP.bat.',
    `  3. Se crea ${nombre}.eap en la misma carpeta y se abre el Explorador señalándolo.`,
    '  4. En Enterprise Architect: Open Project → elige el archivo → Project Browser →',
    '     Model → el paquete del tablero → Modelo de clases → el diagrama ya está dibujado.',
    '',
    'Requisitos: Windows (7, 10 u 11). No hay que instalar nada: el driver de Access de 32 bits',
    'que usa el generador viene con Windows. Puede ser la misma PC donde tienes Enterprise Architect.',
    '',
    'Si Windows muestra "Windows protegió tu PC": clic en "Más información" → "Ejecutar de todas formas".',
    'Ocurre con cualquier .bat descargado de internet.',
    '',
    'Contenido: plan.json (el diagrama ya convertido a las filas de EA), escribir-eap.ps1 (el escritor),',
    'plantilla-vacia.eap (un proyecto vacío de EA 13) y GENERAR_EAP.bat.',
    '',
].join('\r\n');

const zipDe = (archivos) => new Promise((resolve, reject) => {
    const partes = [];
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('data', (parte) => partes.push(parte));
    zip.on('end', () => resolve(Buffer.concat(partes)));
    zip.on('error', reject);
    for (const [nombre, contenido] of archivos) {
        if (Buffer.isBuffer(contenido) || typeof contenido === 'string') zip.append(contenido, { name: nombre });
        else zip.file(contenido.ruta, { name: nombre });
    }
    zip.finalize();
});

/**
 * Kit para generar el .EAP en cualquier PC con Windows: el plan ya calculado, el escritor, la
 * plantilla y un .bat. Es lo que se entrega cuando el servidor no es Windows (p. ej. Render).
 * @param {string} nombre  nombre de archivo seguro (sin espacios ni tildes)
 */
export const kitEap = async (tablero, titulo, nombre) => {
    const carpeta = await mkdtemp(path.join(os.tmpdir(), 'eap-kit-'));
    try {
        const archivoPlan = await prepararPlan(tablero, titulo, carpeta);
        return await zipDe([
            ['GENERAR_EAP.bat', lineasBat(nombre)],
            ['LEEME.txt', `\uFEFF${leeme(nombre)}`],
            ['plan.json', { ruta: archivoPlan }],
            ['escribir-eap.ps1', { ruta: ESCRIBIR }],
            ['plantilla-vacia.eap', { ruta: PLANTILLA }],
        ]);
    } catch (error) {
        console.error('Kit EAP fallido:', error.detalle || error.message);
        if (error.statusCode) throw error;
        throw errorDelUsuario(motivoDelFallo(error), 500);
    } finally {
        await rm(carpeta, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * Genera el .EAP de un tablero y lo devuelve como Buffer.
 * @param {{nodes: object[], edges: object[]}} tablero
 * @param {string} titulo  nombre del tablero (paquete del modelo en EA)
 */
export const generarEap = async (tablero, titulo) => {
    if (!puedeEscribirEap()) {
        throw errorDelUsuario(
            'El archivo .EAP solo se puede generar en un equipo con Windows, porque usa el motor de '
            + 'Access, y este servidor corre en Linux. Genéralo desde la aplicación en tu PC con Windows, '
            + 'o descarga el XMI 2.1, que Enterprise Architect también abre.', 501);
    }
    const carpeta = await mkdtemp(path.join(os.tmpdir(), 'eap-'));
    const archivoEap = path.join(carpeta, 'modelo.eap');
    try {
        const archivoPlan = await prepararPlan(tablero, titulo, carpeta);
        await ejecutar('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ESCRIBIR,
            '-Plan', archivoPlan, '-Base', PLANTILLA, '-Salida', archivoEap,
        ]);
        return await readFile(archivoEap);
    } catch (error) {
        console.error('Exportación EAP fallida:', error.detalle || error.message);
        if (error.statusCode) throw error;
        throw errorDelUsuario(motivoDelFallo(error), 500);
    } finally {
        await rm(carpeta, { recursive: true, force: true }).catch(() => {});
    }
};
