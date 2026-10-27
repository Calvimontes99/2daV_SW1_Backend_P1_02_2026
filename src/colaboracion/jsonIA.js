/**
 * Leer el JSON que devuelve un modelo de lenguaje.
 *
 * No siempre es JSON válido: viene envuelto en ```json, escapa caracteres como en markdown
 * (`1..\*`, `\_`, `\#`, que en JSON son inválidos), deja una coma antes de `}` o mete un salto de
 * línea literal dentro de un texto. Antes, un solo `\*` hacía fallar la lectura y el chat mostraba
 * la respuesta cruda (con el bloque ```json) y sin las marcas de la revisión.
 */

const ESCAPES_VALIDOS = '"\\/bfnrtu';

/** Quita los escapes que JSON no admite: `\*` -> `*` (los pares `\\` se respetan). */
const sinEscapesInvalidos = (s) => s.replace(/\\([\s\S])/g, (par, c) => (ESCAPES_VALIDOS.includes(c) ? par : c));

/** Escapa los saltos de línea y tabulaciones literales que quedaron DENTRO de un texto. */
const sinControlesEnCadenas = (s) => {
  let salida = '';
  let enCadena = false;
  let escapado = false;
  for (const c of s) {
    if (enCadena) {
      if (escapado) { escapado = false; salida += c; continue; }
      if (c === '\\') { escapado = true; salida += c; continue; }
      if (c === '"') { enCadena = false; salida += c; continue; }
      if (c === '\n') { salida += '\\n'; continue; }
      if (c === '\r') { salida += '\\r'; continue; }
      if (c === '\t') { salida += '\\t'; continue; }
      salida += c;
    } else {
      if (c === '"') enCadena = true;
      salida += c;
    }
  }
  return salida;
};

/** Coma antes del cierre de un objeto o una lista. */
const sinComasFinales = (s) => s.replace(/,(\s*[}\]])/g, '$1');

const reparar = (s) => sinComasFinales(sinControlesEnCadenas(sinEscapesInvalidos(s)));

const intentar = (s) => {
  try { return JSON.parse(s); } catch { return undefined; }
};

/** El objeto JSON de la respuesta, o null si no hay forma de leerlo. */
export const extraerJSON = (texto) => {
  const limpio = String(texto || '').replace(/```(?:json)?/gi, '').trim();
  const desde = limpio.indexOf('{');
  const hasta = limpio.lastIndexOf('}');
  const objeto = desde >= 0 && hasta > desde ? limpio.slice(desde, hasta + 1) : null;
  for (const candidato of [limpio, objeto].filter(Boolean)) {
    const tal = intentar(candidato);
    if (tal && typeof tal === 'object') return tal;
    const reparado = intentar(reparar(candidato));
    if (reparado && typeof reparado === 'object') return reparado;
  }
  return null;
};

/**
 * Lo que se le muestra al equipo cuando la respuesta no se pudo leer como JSON: el campo "texto"
 * si se encuentra, o la respuesta sin el bloque ```json. Nunca el JSON crudo.
 */
export const textoLegible = (texto) => {
  const crudo = String(texto || '').trim();
  const campo = crudo.match(/"texto"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
  if (campo) {
    const leido = intentar(`"${sinControlesEnCadenas(sinEscapesInvalidos(campo[1]))}"`);
    if (typeof leido === 'string' && leido.trim()) return leido.trim();
  }
  return crudo.replace(/```(?:json)?/gi, '').trim();
};

export default extraerJSON;
