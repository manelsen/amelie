// src/bancodedados/RepositorioUsuarios.js
/**
 * RepositorioUsuarios - Repositório funcional para usuários
 */

const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

/**
 * Fábrica para o repositório de usuários
 * @param {string} caminhoBanco - Caminho para o arquivo de banco de dados
 * @param {Object} registrador - Objeto para registro de logs
 * @returns {Object} Instância funcional do repositório
 */
const criarRepositorioUsuarios = (caminhoBanco, registrador) => {
  const base = criarRepositorioNeDB(caminhoBanco, registrador);

  return {
    ...base,

    /**
     * Obtém ou cria um registro de usuário.
     * @param {string} idUsuario - ID serializado do usuário (ex: 'xxxxxxxxxx@c.us').
     * @param {object} [dadosUsuario={}] - Dados adicionais do usuário, como nome.
     * @param {string} [dadosUsuario.nome] - Nome do usuário (pushname ou similar).
     * @returns {Promise<Resultado<object>>} Resultado com o documento do usuário.
     */
    obterOuCriarUsuario: async (idUsuario, dadosUsuario = {}) => {
      // 1. Tenta encontrar o usuário existente
      const resultadoBusca = await base.encontrarUm({ id: idUsuario });

      // 2. Se encontrou, retorna o usuário encontrado
      if (resultadoBusca.sucesso && resultadoBusca.dados) {
        return resultadoBusca;
      }

      // 3. Se ocorreu um erro na busca (diferente de não encontrado), retorna a falha
      if (!resultadoBusca.sucesso) {
        registrador.error(`Erro ao buscar usuário ${idUsuario}: ${resultadoBusca.erro.message}`);
        return resultadoBusca;
      }

      // 4. Se não encontrou (resultadoBusca.dados é null), cria um novo usuário
      const nomeUsuario = dadosUsuario.nome || `Usuário${idUsuario.substring(0, 6).replace(/[^0-9]/g, '')}`; // Usa nome fornecido ou gera padrão
      const novoUsuario = {
        id: idUsuario,
        nome: nomeUsuario,
        dataEntrada: new Date(),
        preferencias: {} // Inicializa preferências vazias
      };

      const resultadoInsercao = await base.inserir(novoUsuario);

      return Resultado.mapear(resultadoInsercao, usuarioInserido => {
        registrador.info(`Novo usuário registrado: ${usuarioInserido.nome} (${usuarioInserido.id})`);
        return usuarioInserido;
      });
    },
    
    /**
     * Atualiza preferências do usuário
     */
    atualizarPreferencias: async (idUsuario, preferencias) => {
      return base.atualizar(
        { id: idUsuario },
        { $set: { preferencias } }
      );
    },
    
    /**
     * Busca usuários por nome ou parte do nome
     */
    buscarPorNome: async (termoBusca) => {
      const regex = new RegExp(termoBusca, 'i');
      return base.encontrar({ nome: { $regex: regex } });
    }
  };
};

module.exports = { criarRepositorioUsuarios };
