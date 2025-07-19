// src/db/RepositorioPrompts.js
/**
 * RepositorioPrompts - Repositório para prompts do sistema
 */

const RepositorioNeDB = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

class RepositorioPrompts extends RepositorioNeDB {
  /**
   * Define um prompt de sistema
   * @param {string} idChat - ID do chat
   * @param {string} nome - Nome do prompt
   * @param {string} texto - Texto do prompt
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async definirPrompt(idChat, nome, texto) {
    const textoFormatado = `Seu nome é ${nome}. ${texto}`;
    
    return this.atualizar(
      { chatId: idChat, name: nome }, 
      { chatId: idChat, name: nome, text: textoFormatado }, 
      { upsert: true }
    );
  }
  
  /**
   * Obtém um prompt de sistema pelo nome
   * @param {string} idChat - ID do chat
   * @param {string} nome - Nome do prompt
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async obterPrompt(idChat, nome) {
    return this.encontrarUm({ chatId: idChat, name: nome });
  }
  
  /**
   * Lista todos os prompts de sistema para um chat
   * @param {string} idChat - ID do chat
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async listarPrompts(idChat) {
    return this.encontrar({ chatId: idChat });
  }
  
  /**
   * Exclui um prompt de sistema
   * @param {string} idChat - ID do chat
   * @param {string} nome - Nome do prompt
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async excluirPrompt(idChat, nome) {
    // Refatorado: Retorna diretamente o resultado de remover (Resultado<number>)
    // para alinhar com a interface IRepositorioPrompts.
    return this.remover({ chatId: idChat, name: nome });
  }
}

module.exports = RepositorioPrompts;