// src/db/RepositorioUsuarios.js
/**
 * RepositorioUsuarios - Repositório para usuários
 */

const RepositorioNeDB = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

class RepositorioUsuarios extends RepositorioNeDB {
  /**
   * Obtém ou cria um registro de usuário.
   * @param {string} idUsuario - ID serializado do usuário (ex: 'xxxxxxxxxx@c.us').
   * @param {object} [dadosUsuario={}] - Dados adicionais do usuário, como nome.
   * @param {string} [dadosUsuario.nome] - Nome do usuário (pushname ou similar).
   * @returns {Promise<Resultado<object>>} Resultado com o documento do usuário.
   */
  async obterOuCriarUsuario(idUsuario, dadosUsuario = {}) {
    // 1. Tenta encontrar o usuário existente
    const resultadoBusca = await this.encontrarUm({ id: idUsuario });

    // 2. Se encontrou, retorna o usuário encontrado
    if (resultadoBusca.sucesso && resultadoBusca.dados) {
      // Opcional: Atualizar o nome se um novo nome foi fornecido e é diferente?
      // if (dadosUsuario.nome && dadosUsuario.nome !== resultadoBusca.dados.nome) {
      //   await this.atualizar({ id: idUsuario }, { $set: { nome: dadosUsuario.nome } });
      //   resultadoBusca.dados.nome = dadosUsuario.nome; // Atualiza o objeto retornado
      // }
      return resultadoBusca;
    }

    // 3. Se ocorreu um erro na busca (diferente de não encontrado), retorna a falha
    if (!resultadoBusca.sucesso) {
      this.registrador.error(`Erro ao buscar usuário ${idUsuario}: ${resultadoBusca.erro.message}`);
      return resultadoBusca;
    }

    // 4. Se não encontrou (resultadoBusca.dados é null), cria um novo usuário
    const nomeUsuario = dadosUsuario.nome || `Usuário${idUsuario.substring(0, 6).replace(/[^0-9]/g, '')}`; // Usa nome fornecido ou gera padrão
    const novoUsuario = {
      id: idUsuario,
      nome: nomeUsuario,
      dataEntrada: new Date(),
      preferencias: {} // Inicializa preferências vazias
      // Adicionar outros campos padrão se necessário
    };

    const resultadoInsercao = await this.inserir(novoUsuario);

    return Resultado.mapear(resultadoInsercao, usuarioInserido => {
      this.registrador.info(`Novo usuário registrado: ${usuarioInserido.nome} (${usuarioInserido.id})`);
      return usuarioInserido;
    });
    // Nota: A lógica de fallback complexa com try/catch foi removida,
    // pois a busca de contato e a lógica de nome padrão agora são responsabilidade do chamador.
    // O repositório foca em encontrar ou criar com os dados fornecidos.
  }
  
  /**
   * Atualiza preferências do usuário
   * @param {string} idUsuario - ID do usuário
   * @param {Object} preferencias - Preferências a atualizar
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async atualizarPreferencias(idUsuario, preferencias) {
    return this.atualizar(
      { id: idUsuario },
      { $set: { preferencias } }
    );
  }
  
  /**
   * Busca usuários por nome ou parte do nome
   * @param {string} termoBusca - Termo para busca
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async buscarPorNome(termoBusca) {
    // Criando uma expressão regular para busca case-insensitive
    const regex = new RegExp(termoBusca, 'i');
    return this.encontrar({ nome: { $regex: regex } });
  }
}

module.exports = RepositorioUsuarios;