// src/bancodedados/RepositorioPrompts.js
/**
 * RepositorioPrompts - Repositório funcional para prompts do sistema
 */

const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { Resultado } = require('./Repositorio');

const criarRepositorioPrompts = (caminhoBanco, registrador) => {
  const base = criarRepositorioNeDB(caminhoBanco, registrador);

  return {
    ...base,

    /**
     * Define um prompt de sistema
     */
    definirPrompt: async (idChat, nome, texto) => {
      const textoFormatado = `Seu nome é ${nome}. ${texto}`;
      
      return base.atualizar(
        { chatId: idChat, name: nome }, 
        { chatId: idChat, name: nome, text: textoFormatado }, 
        { upsert: true }
      );
    },
    
    /**
     * Obtém um prompt de sistema pelo nome
     */
    obterPrompt: async (idChat, nome) => {
      return base.encontrarUm({ chatId: idChat, name: nome });
    },
    
    /**
     * Lista todos os prompts de sistema para um chat
     */
    listarPrompts: async (idChat) => {
      return base.encontrar({ chatId: idChat });
    },
    
    /**
     * Exclui um prompt de sistema
     */
    excluirPrompt: async (idChat, nome) => {
      return base.remover({ chatId: idChat, name: nome });
    }
  };
};

module.exports = { criarRepositorioPrompts };
