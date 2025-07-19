// src/db/RepositorioGrupos.js
/**
 * RepositorioGrupos - Repositório para grupos de WhatsApp
 */

const RepositorioNeDB = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

class RepositorioGrupos extends RepositorioNeDB {
  /**
   * Obtém ou cria um registro de grupo.
   * @param {string} idGrupo - ID serializado do grupo (ex: 'xxxxxxxxxx@g.us').
   * @param {object} [dadosGrupo={}] - Dados adicionais do grupo, como nome.
   * @param {string} [dadosGrupo.nome] - Nome/Título do grupo.
   * @returns {Promise<Resultado<object>>} Resultado com o documento do grupo.
   */
  async obterOuCriarGrupo(idGrupo, dadosGrupo = {}) {
    // 1. Tenta encontrar o grupo existente
    const resultadoBusca = await this.encontrarUm({ id: idGrupo });

    // 2. Se encontrou, retorna o grupo encontrado
    if (resultadoBusca.sucesso && resultadoBusca.dados) {
       // Opcional: Atualizar o título se fornecido e diferente?
       // if (dadosGrupo.nome && dadosGrupo.nome !== resultadoBusca.dados.title) { ... }
      return resultadoBusca;
    }

    // 3. Se ocorreu um erro na busca, retorna a falha
    if (!resultadoBusca.sucesso) {
      this.registrador.error(`Erro ao buscar grupo ${idGrupo}: ${resultadoBusca.erro.message}`);
      return resultadoBusca;
    }

    // 4. Se não encontrou, cria um novo grupo
    const nomeGrupo = dadosGrupo.nome || `Grupo_${idGrupo.substring(0, 6)}`; // Usa nome fornecido ou gera padrão
    const novoGrupo = {
      id: idGrupo,
      title: nomeGrupo, // Usa 'title' para consistência com o schema anterior
      createdAt: new Date(),
      membros: [] // Inicializa lista de membros vazia
      // Adicionar outros campos padrão se necessário
    };

    const resultadoInsercao = await this.inserir(novoGrupo);

    return Resultado.mapear(resultadoInsercao, grupoInserido => {
      this.registrador.info(`Novo grupo registrado: ${grupoInserido.title} (${grupoInserido.id})`);
      return grupoInserido;
    });
  }
  
  /**
   * Adiciona membro ao grupo
   * @param {string} idGrupo - ID do grupo
   * @param {string} idMembro - ID do membro
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async adicionarMembro(idGrupo, idMembro) {
    return this.atualizar(
      { id: idGrupo },
      { $addToSet: { membros: idMembro } }
    );
  }
  
  /**
   * Remove membro do grupo
   * @param {string} idGrupo - ID do grupo
   * @param {string} idMembro - ID do membro
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async removerMembro(idGrupo, idMembro) {
    return this.atualizar(
      { id: idGrupo },
      { $pull: { membros: idMembro } }
    );
  }
  
  // Método removido da interface pública, pois não pertence ao contrato IRepositorioGrupos
  // async listarGrupos() { ... }
}

module.exports = RepositorioGrupos;