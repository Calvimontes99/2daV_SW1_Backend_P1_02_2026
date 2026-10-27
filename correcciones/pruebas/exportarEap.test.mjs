// Exportación a Enterprise Architect (.EAP) de un tablero con clase de asociación.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { especificacionDesdeTablero } from '../../src/eap/especificacionDesdeTablero.js';
import { generarEap, puedeEscribirEap } from '../../src/eap/exportarEap.js';
import { leerModeloEAP } from '../../src/importers/eapReader.js';

const PREPARAR = fileURLToPath(new URL('../../src/eap/scripts/preparar-plan.mjs', import.meta.url));

const clase = (id, nombre, x, y, atributos, extra = {}) => ({
    id, type: 'classNode', position: { x, y }, measured: { width: 340, height: 160 },
    data: { className: nombre, attributes: atributos, methods: [], ...extra },
});

// chofer y lineas (1..* a 1..*) con LineasDetalle como clase de asociación (las tres marcas del editor)
const tableroConClase = () => ({
    nodes: [
        clase('n-chofer', 'chofer', 0, 400, ['codigo: int']),
        clase('n-lineas', 'lineas', 700, 0, ['id: int']),
        clase('n-detalle', 'LineasDetalle', 700, 450, ['idLinea: int'], { isAssociationClass: true, associatedEdgeId: 'e-maneja' }),
        clase('n-micro', 'microbuses', 0, 0, ['placa: String']),
    ],
    edges: [
        {
            id: 'e-maneja', source: 'n-chofer', target: 'n-lineas', type: 'umlEdge',
            data: { type: 'Association', startLabel: '1..*', endLabel: '1..*', hasAssociationClass: true, associationClassNodeId: 'n-detalle' },
        },
        {
            id: 'assoc-edge-e-maneja', source: 'n-detalle', target: 'n-lineas', type: 'umlEdge',
            data: { type: 'AssociationClassConnection', isAssociationConnection: true, parentRelationId: 'e-maneja' },
        },
        { id: 'e-tiene', source: 'n-micro', target: 'n-lineas', type: 'umlEdge', data: { type: 'Association', label: 'tiene' } },
    ],
});

test('la especificación lleva la clase de asociación en su relación, con cualquiera de las marcas', () => {
    const spec = especificacionDesdeTablero(tableroConClase(), 'Prueba');
    const [relacion, otra] = spec.diagramas[0].relaciones;
    assert.equal(relacion.claseAsociacion, 'n-detalle');
    assert.equal(otra.claseAsociacion, undefined);
    assert.equal(spec.diagramas[0].relaciones.length, 2, 'la línea punteada no es una relación');

    // Solo la línea punteada (marca de una versión anterior) también alcanza
    const soloLinea = tableroConClase();
    soloLinea.nodes[2].data = { className: 'LineasDetalle', attributes: [], methods: [] };
    soloLinea.edges[0].data = { type: 'Association' };
    assert.equal(especificacionDesdeTablero(soloLinea, 'Prueba').diagramas[0].relaciones[0].claseAsociacion, 'n-detalle');
});

test('el plan marca el conector como EA (SubType Class) y completa la clase después de insertarlo', () => {
    const carpeta = mkdtempSync(path.join(os.tmpdir(), 'plan-ac-'));
    try {
        const archivoSpec = path.join(carpeta, 'spec.json');
        const archivoPlan = path.join(carpeta, 'plan.json');
        writeFileSync(archivoSpec, JSON.stringify(especificacionDesdeTablero(tableroConClase(), 'Prueba')));
        execFileSync(process.execPath, [PREPARAR, archivoSpec, archivoPlan], { stdio: 'pipe' });
        const { pasos } = JSON.parse(readFileSync(archivoPlan, 'utf8'));

        const conectores = pasos.filter((p) => p.accion === 'insertar' && p.tabla === 't_connector');
        const conClase = conectores.find((p) => p.valores.SubType === 'Class');
        assert.ok(conClase, 'hay un conector con SubType "Class"');
        assert.deepEqual(conClase.valores.PDATA1, { refTexto: 'obj:n-detalle' });
        assert.equal(conClase.valores.Connector_Type, 'Association');
        assert.equal(conClase.valores.DestIsNavigable, false);
        assert.equal(conectores.filter((p) => p.valores.SubType === 'Class').length, 1);

        const actualizar = pasos.filter((p) => p.accion === 'actualizar');
        assert.deepEqual(actualizar, [{
            accion: 'actualizar', tabla: 't_object', columnaId: 'Object_ID', id: { ref: 'obj:n-detalle' },
            valores: { NType: 17, PDATA4: { refTexto: conClase.clave } },
        }]);
        assert.ok(pasos.indexOf(actualizar[0]) > pasos.indexOf(conClase), 'se actualiza cuando el conector ya existe');
    } finally {
        rmSync(carpeta, { recursive: true, force: true });
    }
});

test('el .EAP generado trae la clase de asociación y se vuelve a importar unida', { skip: !puedeEscribirEap() && 'escribir .EAP necesita Windows' }, async () => {
    const buffer = await generarEap(tableroConClase(), 'Prueba clase de asociacion');
    assert.equal(buffer[0x14], 0, 'sigue siendo Jet 3 (el formato que abre EA 13)');
    const modelo = leerModeloEAP(buffer);
    const id = (nombre) => modelo.clases.find((c) => c.nombre === nombre).id;
    const maneja = modelo.conectores.find((c) => c.origen === id('chofer') && c.destino === id('lineas'));
    assert.equal(maneja.claseAsociacion, id('LineasDetalle'));
    assert.deepEqual([maneja.cardOrigen, maneja.cardDestino], ['1..*', '1..*']);
    assert.equal(modelo.conectores.find((c) => c.nombre === 'tiene').claseAsociacion, null);
});
