// src/bancodedados/Repositorio.js
/**
 * Repositorio - Interface base funcional para acesso a dados
 * 
 * Define o contrato para todas as implementações de repositórios
 * seguindo princípios de programação funcional.
 */

// Estrutura Resultado para tratamento funcional de erros (Padrão Ferroviário)
const Resultado = {
  sucesso: (dados) => ({ sucesso: true, dados, erro: null }),
  falha: (erro) => ({ sucesso: false, dados: null, erro }),
  
  // Funções utilitárias para encadeamento
  mapear: (resultado, fn) => resultado.sucesso ? Resultado.sucesso(fn(resultado.dados)) : resultado,
  encadear: (resultado, fn) => resultado.sucesso ? fn(resultado.dados) : resultado,
  
  // Manipuladores de resultado
  dobrar: (resultado, aoSucesso, aoFalhar) => 
    resultado.sucesso ? aoSucesso(resultado.dados) : aoFalhar(resultado.erro)
};

/**
 * Fábrica para a interface base de todos os repositórios
 * Todas as operações retornam um Resultado para tratamento funcional de erros
 */
const criarRepositorio = () => {
  return {
    /**
     * Encontra um único documento
     * @param {Object} consulta - Critérios de busca
     * @returns {Promise<Resultado>} Resultado da operação
     */
    encontrarUm: async (consulta) => {
      throw new Error("Método encontrarUm não implementado");
    },

    /**
     * Encontra múltiplos documentos
     * @param {Object} consulta - Critérios de busca
     * @param {Object} opcoes - Opções como limite, pular, ordenar
     * @returns {Promise<Resultado>} Resultado da operação
     */
    encontrar: async (consulta, opcoes = {}) => {
      throw new Error("Método encontrar não implementado");
    },

    /**
     * Insere um novo documento
     * @param {Object} documento - Documento a ser inserido
     * @returns {Promise<Resultado>} Resultado da operação
     */
    inserir: async (documento) => {
      throw new Error("Método inserir não implementado");
    },

    /**
     * Atualiza documentos
     * @param {Object} consulta - Critérios de busca
     * @param {Object} atualizacao - Atualizações a aplicar
     * @param {Object} opcoes - Opções como upsert, multi
     * @returns {Promise<Resultado>} Resultado da operação
     */
    atualizar: async (consulta, atualizacao, opcoes = {}) => {
      throw new Error("Método atualizar não implementado");
    },

    /**
     * Remove documentos
     * @param {Object} consulta - Critérios de busca
     * @param {Object} opcoes - Opções como multi
     * @returns {Promise<Resultado>} Resultado da operação
     */
    remover: async (consulta, opcoes = {}) => {
      throw new Error("Método remover não implementado");
    },

    /**
     * Conta documentos
     * @param {Object} consulta - Critérios de busca
     * @returns {Promise<Resultado>} Resultado da operação
     */
    contar: async (consulta) => {
      throw new Error("Método contar não implementado");
    }
  };
};

module.exports = { criarRepositorio, Resultado };
