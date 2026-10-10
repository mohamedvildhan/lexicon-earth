/**
 * Source adapter contract.
 * Implement searchCandidates + fetchLineage; register in sources/index.js.
 */
export class SourceAdapter {
  constructor({ id, name, license, attribution, homepage }) {
    this.id = id;
    this.name = name;
    this.license = license;
    this.attribution = attribution;
    this.homepage = homepage;
  }

  /** @returns {Promise<Array<{id, lemma, language, languageCode, sense?, gloss?, sourceId, meta?}>>} */
  async searchCandidates(_query, _opts = {}) {
    return [];
  }

  /**
   * @returns {Promise<{nodes, edges, citations, definition?, gaps?, alternatives?} | null>}
   */
  async fetchLineage(_candidate, _opts = {}) {
    return null;
  }
}
