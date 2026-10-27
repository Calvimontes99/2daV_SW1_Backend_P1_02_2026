/**
 * Clases de asociación del tablero (copia de la regla de frontend/src/utils/claseAsociacion.js).
 *
 * El editor marca la clase de asociación en tres lugares: la relación apunta a su clase
 * (hasAssociationClass + associationClassNodeId), la clase apunta a su relación
 * (isAssociationClass + associatedEdgeId) y una arista "línea punteada" une ambas
 * (isAssociationConnection + parentRelationId). Basta con cualquiera de las tres.
 */

/**
 * @param {Array} nodos  nodos del tablero
 * @param {Array} aristas  aristas del tablero
 * @param {(claseId: string) => boolean} existe  si la clase cuenta (p. ej. está en el modelo)
 * @returns {Map<string, string>} id de la relación -> id de su clase de asociación. Solo pares
 *   cuya relación existe y cuya clase existe y no es uno de los extremos de la relación.
 */
export const clasesDeAsociacionDelTablero = (nodos, aristas, existe = () => true) => {
    const mapa = new Map();
    const poner = (relacionId, claseId) => {
        if (relacionId && claseId && existe(claseId) && !mapa.has(relacionId)) mapa.set(relacionId, claseId);
    };
    (aristas || []).forEach((e) => {
        const d = e.data || {};
        if (d.hasAssociationClass) poner(e.id, d.associationClassNodeId || d.associationClassId);
    });
    (nodos || []).forEach((n) => {
        const d = n.data || {};
        if (d.isAssociationClass) poner(d.associatedEdgeId, n.id);
    });
    (aristas || []).forEach((e) => {
        const d = e.data || {};
        if (d.isAssociationConnection) poner(d.parentRelationId, e.source);
    });
    const porId = new Map((aristas || []).map((e) => [e.id, e]));
    for (const [relacionId, claseId] of [...mapa]) {
        const relacion = porId.get(relacionId);
        if (!relacion || relacion.source === claseId || relacion.target === claseId) mapa.delete(relacionId);
    }
    return mapa;
};

export default clasesDeAsociacionDelTablero;
