// Lectura de proyectos de Enterprise Architect (importers/eapReader.js): la clase de asociación.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modeloDesdeTablas } from '../../src/importers/eapReader.js';

/**
 * Filas como las del proyecto del usuario "diagramass sig.EAP" (EA 13): chofer y lineas unidas por
 * una asociación 1..* / 1..* cuya clase de asociación es LineasDetalle. EA la guarda en dos lados:
 * la clase con NType = 17 y el id del conector en PDATA4; el conector con SubType = "Class" y el id
 * de la clase en PDATA1.
 */
const tablasDelUsuario = ({ ladoClase = true, ladoConector = true } = {}) => ({
    t_package: [{ package_id: 5, name: 'Class Model', parent_id: 1 }],
    t_object: [
        { object_id: 60, object_type: 'Class', name: 'chofer', package_id: 5, ntype: 0, pdata4: '0' },
        { object_id: 43, object_type: 'Class', name: 'lineas', package_id: 5, ntype: 0, pdata4: '0' },
        {
            object_id: 62, object_type: 'Class', name: 'LineasDetalle', package_id: 5,
            ntype: ladoClase ? 17 : 0, pdata4: ladoClase ? '35' : '0',
        },
        { object_id: 70, object_type: 'Note', name: 'nota', package_id: 5 },
    ],
    t_attribute: [
        { object_id: 62, name: 'idLinea', type: 'int', scope: 'Private', pos: 0 },
        { object_id: 62, name: 'codigo', type: 'int', scope: 'Private', pos: 1 },
    ],
    t_connector: [
        {
            connector_id: 35, connector_type: 'Association', subtype: ladoConector ? 'Class' : '',
            pdata1: ladoConector ? '62' : '', start_object_id: 60, end_object_id: 43,
            sourcecard: '1..*', destcard: '1..*',
        },
        { connector_id: 36, connector_type: 'NoteLink', start_object_id: 70, end_object_id: 62 },
    ],
    t_diagram: [{ diagram_id: 5, name: 'Class Model', diagram_type: 'Logical', package_id: 5 }],
    t_diagramobjects: [
        { diagram_id: 5, object_id: 60, rectleft: 290, recttop: -680, rectright: 405, rectbottom: -760 },
        { diagram_id: 5, object_id: 43, rectleft: 370, recttop: -315, rectright: 540, rectbottom: -540 },
        { diagram_id: 5, object_id: 62, rectleft: 490, recttop: -605, rectright: 615, rectbottom: -690 },
    ],
});
const filasDe = (tablas) => (nombre) => tablas[nombre] || [];

test('la asociación con clase de asociación (NType 17 + SubType Class) la nombra', () => {
    const modelo = modeloDesdeTablas(filasDe(tablasDelUsuario()));
    const conector = modelo.conectores.find((c) => c.id === 35);
    assert.equal(conector.claseAsociacion, 62);
    assert.deepEqual([conector.origen, conector.destino, conector.cardOrigen, conector.cardDestino], [60, 43, '1..*', '1..*']);
    assert.deepEqual(modelo.clases.find((c) => c.id === 62).atributos.map((a) => a.nombre), ['idLinea', 'codigo']);
    assert.equal(modelo.conectores.length, 1, 'el NoteLink no es una relación entre clases');
    assert.deepEqual(modelo.diagramas[0].objetos.find((o) => o.clase === 62), { clase: 62, left: 490, top: 605, right: 615, bottom: 690 });
});

test('basta con que la marca esté en uno de los dos lados', () => {
    const soloClase = modeloDesdeTablas(filasDe(tablasDelUsuario({ ladoConector: false })));
    assert.equal(soloClase.conectores[0].claseAsociacion, 62);
    const soloConector = modeloDesdeTablas(filasDe(tablasDelUsuario({ ladoClase: false })));
    assert.equal(soloConector.conectores[0].claseAsociacion, 62);
    const ninguno = modeloDesdeTablas(filasDe(tablasDelUsuario({ ladoClase: false, ladoConector: false })));
    assert.equal(ninguno.conectores[0].claseAsociacion, null);
});

test('una marca que apunta a algo que no es una clase o a un extremo se ignora', () => {
    const tablas = tablasDelUsuario({ ladoClase: false });
    tablas.t_connector[0].pdata1 = '70'; // la nota
    assert.equal(modeloDesdeTablas(filasDe(tablas)).conectores[0].claseAsociacion, null);
    tablas.t_connector[0].pdata1 = '60'; // su propio extremo
    assert.equal(modeloDesdeTablas(filasDe(tablas)).conectores[0].claseAsociacion, null);
});
