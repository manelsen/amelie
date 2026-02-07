// src/bancodedados/RepositorioNeDB.js
/**
 * RepositorioNeDB - Implementação funcional de Repositorio para NeDB
 * 
 * Adapta a interface Repositorio para o NeDB, tratando erros de forma funcional.
 */

const Datastore = require('@seald-io/nedb');
const { criarRepositorio, Resultado } = require('./Repositorio');
const fs = require('fs');
const path = require('path');

/**
 * Fábrica para o repositório NeDB
 * @param {string} caminhoBanco - Caminho para o arquivo de banco de dados
 * @param {Object} registrador - Objeto para registro de logs
 * @returns {Object} Instância funcional do repositório
 */
const criarRepositorioNeDB = (caminhoBanco, registrador) => {
  let bancoDados;
  
  try {
    // Garantir que o diretório exista
    const diretorio = path.dirname(caminhoBanco);
    if (!fs.existsSync(diretorio)) {
      fs.mkdirSync(diretorio, { recursive: true });
      registrador.info(`Diretório criado: ${diretorio}`);
    }
    
    // Verificar permissões do diretório
    fs.accessSync(diretorio, fs.constants.R_OK | fs.constants.W_OK);
    
    bancoDados = new Datastore({ 
      filename: caminhoBanco, 
      autoload: true,
      onload: (err) => {
        if (err) registrador.error(`Erro ao carregar banco: ${err.message}`);
      }
    });
  } catch (erro) {
    registrador.error(`Erro ao inicializar repositório: ${erro.message}`);
    throw erro;
  }

  const base = criarRepositorio();

  return {
    ...base,

    /**
     * Encontra um único documento
     */
    encontrarUm: async (consulta) => {
      return new Promise(resolver => {
        bancoDados.findOne(consulta, (erro, documento) => {
          if (erro) {
            registrador.error(`Erro ao buscar documento: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso(documento));
          }
        });
      });
    },

    /**
     * Encontra múltiplos documentos
     */
    encontrar: async (consulta, opcoes = {}) => {
      return new Promise(resolver => {
        let cursor = bancoDados.find(consulta);
        
        if (opcoes.ordenar) cursor = cursor.sort(opcoes.ordenar);
        if (opcoes.pular) cursor = cursor.skip(opcoes.pular);
        if (opcoes.limite) cursor = cursor.limit(opcoes.limite);
        
        cursor.exec((erro, documentos) => {
          if (erro) {
            registrador.error(`Erro ao buscar documentos: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            const documentosImutaveis = documentos.map(doc => ({ ...doc }));
            resolver(Resultado.sucesso(documentosImutaveis));
          }
        });
      });
    },

    /**
     * Insere um novo documento
     */
    inserir: async (documento) => {
      const copiaDocumento = { ...documento };
      
      return new Promise(resolver => {
        bancoDados.insert(copiaDocumento, (erro, novoDoc) => {
          if (erro) {
            registrador.error(`Erro ao inserir documento: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso(novoDoc));
          }
        });
      });
    },

    /**
     * Atualiza documentos
     */
    atualizar: async (consulta, atualizacao, opcoes = {}) => {
      return new Promise(resolver => {
        bancoDados.update(consulta, atualizacao, opcoes, (erro, numAfetados, documentosAfetados, upsert) => {
          if (erro) {
            registrador.error(`Erro ao atualizar documentos: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso({ 
              numAfetados, 
              documentosAfetados: documentosAfetados ? { ...documentosAfetados } : null, 
              upsert 
            }));
          }
        });
      });
    },

    /**
     * Remove documentos
     */
    remover: async (consulta, opcoes = {}) => {
      return new Promise(resolver => {
        bancoDados.remove(consulta, opcoes, (erro, numRemovidos) => {
          if (erro) {
            registrador.error(`Erro ao remover documentos: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso(numRemovidos));
          }
        });
      });
    },

    /**
     * Conta documentos
     */
    contar: async (consulta) => {
      return new Promise(resolver => {
        bancoDados.count(consulta, (erro, contagem) => {
          if (erro) {
            registrador.error(`Erro ao contar documentos: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso(contagem));
          }
        });
      });
    },

    /**
     * Cria índice para o banco de dados
     */
    garantirIndice: async (nomeCampo, opcoes = {}) => {
      return new Promise(resolver => {
        bancoDados.ensureIndex({ fieldName: nomeCampo, ...opcoes }, (erro) => {
          if (erro) {
            registrador.error(`Erro ao criar índice: ${erro.message}`);
            resolver(Resultado.falha(erro));
          } else {
            resolver(Resultado.sucesso(true));
          }
        });
      });
    }
  };
};

module.exports = { criarRepositorioNeDB };
