// Leer el JSON que devuelve la IA aunque no sea JSON estricto (colaboracion/jsonIA.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extraerJSON, textoLegible } from '../../src/colaboracion/jsonIA.js';

// Respuesta real de Gemini en una revisión: escapó el asterisco como en markdown ("1..\*")
const REVISION_REAL = String.raw`
` + '```json' + String.raw`
{
"tipo": "revision",
"texto": "Usuario Prueba 1, he revisado el diagrama:\n\n- La multiplicidad en la relación 'NotaVenta → Objetivo' es 1 a 1..\*.",
"observaciones": [
{ "clase": "NotaVenta", "gravedad": "aviso", "texto": "Revisar multiplicidad de relación con 'Objetivo' (1 a 1..\*)." },
{ "clase": "Entrenador", "gravedad": "error", "texto": "El método emitirNotaVenta() declara un tipo de retorno no definido." }
],
"ideas": []
}
` + '```';

test('una revisión con "\\*" (escape de markdown) se lee igual, con sus observaciones', () => {
  assert.throws(() => JSON.parse(REVISION_REAL.replace(/```(?:json)?/g, '')), 'el JSON de la IA no es válido tal cual');
  const r = extraerJSON(REVISION_REAL);
  assert.equal(r.tipo, 'revision');
  assert.match(r.texto, /1 a 1\.\.\*\./);
  assert.equal(r.observaciones.length, 2);
  assert.equal(r.observaciones[1].gravedad, 'error');
});

test('se toleran la coma final y los saltos de línea literales dentro de un texto', () => {
  const r = extraerJSON('{"tipo": "respuesta", "texto": "línea 1\nlínea 2", "ideas": [1, 2,],}');
  assert.deepEqual(r, { tipo: 'respuesta', texto: 'línea 1\nlínea 2', ideas: [1, 2] });
  // Un \\ legítimo (barra invertida en el texto) no se toca
  assert.equal(extraerJSON(String.raw`{"texto": "C:\\Users\\Ana"}`).texto, String.raw`C:\Users\Ana`);
  assert.equal(extraerJSON('Claro, aquí va: {"tipo":"idea","texto":"x"} ¡suerte!').tipo, 'idea');
  assert.equal(extraerJSON('sin json'), null);
});

test('si no se puede leer, se muestra el texto y nunca el JSON crudo', () => {
  const roto = '```json\n{"tipo": "revision", "texto": "Revisé el diagrama: falta la clave de Venta \\*.", "observaciones": [ {"clase": }\n```';
  assert.equal(extraerJSON(roto), null);
  assert.equal(textoLegible(roto), 'Revisé el diagrama: falta la clave de Venta *.');
  assert.equal(textoLegible('Hola equipo'), 'Hola equipo');
});
