// src/bancodedados/RepositorioGrupos.js
/**
 * RepositorioGrupos - Repositório funcional para grupos de WhatsApp
 */

const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

const criarRepositorioGrupos = (caminhoBanco, registrador) => {
  const base = criarRepositorioNeDB(caminhoBanco, registrador);

  return {
    ...base,

    /**
     * Obtém ou cria um registro de grupo.
     */
    obterOuCriarGrupo: async (idGrupo, dadosGrupo = {}) => {
      const resultadoBusca = await base.encontrarUm({ id: idGrupo });

      if (resultadoBusca.sucesso && resultadoBusca.dados) {
        return resultadoBusca;
      }

      if (!resultadoBusca.sucesso) {
        registrador.error(`Erro ao buscar grupo ${idGrupo}: ${resultadoBusca.erro.message}`);
        return resultadoBusca;
      }

      const nomeGrupo = dadosGrupo.nome || `Grupo_${idGrupo.substring(0, 6)}`;
      const novoGrupo = {
        id: idGrupo,
        title: nomeGrupo,
        createdAt: new Date(),
        membros: []
      };

      const resultadoInsercao = await base.inserir(novoGrupo);

      return Resultado.mapear(resultadoInsercao, grupoInserido => {
        registrador.info(`Novo grupo registrado: ${grupoInserido.title} (${grupoInserido.id})`);
        return grupoInserido;
      });
    },
    
    /**
     * Adiciona membro ao grupo
     */
    adicionarMembro: async (idGrupo, idMembro) => {
      return base.atualizar(
        { id: idGrupo },
        { $addToSet: { membros: idMembro } }
      );
    },
    
    /**
     * Remove membro do grupo
     */
    removerMembro: async (idGrupo, idMembro) => {
      return base.atualizar(
        { id: idGrupo },
        { $pull: { membros: idMembro } }
      );
    }
  };
};

module.exports = { criarRepositorioGrupos };
