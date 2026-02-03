// src/db/RepositorioNeDB.js
/**
 * RepositorioNeDB - Implementação de Repositorio para NeDB
 * 
 * Adapta a interface Repositorio para o NeDB, tratando erros de forma funcional.
 */

const Datastore = require('@seald-io/nedb');
const { Repositorio, Resultado } = require('./Repositorio');
const fs = require('fs');
const path = require('path');

class RepositorioNeDB extends Repositorio {
  /**
   * @param {string} caminhoBanco - Caminho para o arquivo de banco de dados
   * @param {Object} registrador - Objeto para registro de logs
   */
  constructor(caminhoBanco, registrador) {
  super();
  
  try {
    // Garantir que o diretório exista
    const diretorio = path.dirname(caminhoBanco);
    if (!fs.existsSync(diretorio)) {
      fs.mkdirSync(diretorio, { recursive: true });
      registrador.info(`Diretório criado: ${diretorio}`);
    }
    
    // Verificar permissões do diretório
    fs.accessSync(diretorio, fs.constants.R_OK | fs.constants.W_OK);
    
    this.bancoDados = new Datastore({ 
      filename: caminhoBanco, 
      autoload: true,
      onload: (err) => {
        if (err) registrador.error(`Erro ao carregar banco: ${err.message}`);
      }
    });
    this.registrador = registrador;
  } catch (erro) {
    registrador.error(`Erro ao inicializar repositório: ${erro.message}`);
    throw erro;
  }
}

  /**
   * Encontra um único documento
   * @param {Object} consulta - Critérios de busca
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async encontrarUm(consulta) {
    return new Promise(resolver => {
      this.bancoDados.findOne(consulta, (erro, documento) => {
        if (erro) {
          this.registrador.error(`Erro ao buscar documento: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          resolver(Resultado.sucesso(documento));
        }
      });
    });
  }

  /**
   * Encontra múltiplos documentos
   * @param {Object} consulta - Critérios de busca
   * @param {Object} opcoes - Opções como limite, pular, ordenar
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async encontrar(consulta, opcoes = {}) {
    return new Promise(resolver => {
      let cursor = this.bancoDados.find(consulta);
      
      if (opcoes.ordenar) cursor = cursor.sort(opcoes.ordenar);
      if (opcoes.pular) cursor = cursor.skip(opcoes.pular);
      if (opcoes.limite) cursor = cursor.limit(opcoes.limite);
      
      cursor.exec((erro, documentos) => {
        if (erro) {
          this.registrador.error(`Erro ao buscar documentos: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          // Imutabilidade - cria cópias profundas dos documentos
          const documentosImutaveis = documentos.map(doc => ({ ...doc }));
          resolver(Resultado.sucesso(documentosImutaveis));
        }
      });
    });
  }

  /**
   * Insere um novo documento
   * @param {Object} documento - Documento a ser inserido
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async inserir(documento) {
    // Criar cópia para garantir imutabilidade
    const copiaDocumento = { ...documento };
    
    return new Promise(resolver => {
      this.bancoDados.insert(copiaDocumento, (erro, novoDoc) => {
        if (erro) {
          this.registrador.error(`Erro ao inserir documento: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          resolver(Resultado.sucesso(novoDoc));
        }
      });
    });
  }

  /**
   * Atualiza documentos
   * @param {Object} consulta - Critérios de busca
   * @param {Object} atualizacao - Atualizações a aplicar
   * @param {Object} opcoes - Opções como upsert, multi
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async atualizar(consulta, atualizacao, opcoes = {}) {
    return new Promise(resolver => {
      this.bancoDados.update(consulta, atualizacao, opcoes, (erro, numAfetados, documentosAfetados, upsert) => {
        if (erro) {
          this.registrador.error(`Erro ao atualizar documentos: ${erro.message}`);
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
  }

  /**
   * Remove documentos
   * @param {Object} consulta - Critérios de busca
   * @param {Object} opcoes - Opções como multi
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async remover(consulta, opcoes = {}) {
    return new Promise(resolver => {
      this.bancoDados.remove(consulta, opcoes, (erro, numRemovidos) => {
        if (erro) {
          this.registrador.error(`Erro ao remover documentos: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          resolver(Resultado.sucesso(numRemovidos));
        }
      });
    });
  }

  /**
   * Conta documentos
   * @param {Object} consulta - Critérios de busca
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async contar(consulta) {
    return new Promise(resolver => {
      this.bancoDados.count(consulta, (erro, contagem) => {
        if (erro) {
          this.registrador.error(`Erro ao contar documentos: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          resolver(Resultado.sucesso(contagem));
        }
      });
    });
  }

  /**
   * Cria índice para o banco de dados
   * @param {Object} nomeCampo - Campo para indexar
   * @param {Object} opcoes - Opções do índice
   * @returns {Promise<Resultado>} Resultado da operação
   */
  async garantirIndice(nomeCampo, opcoes = {}) {
    return new Promise(resolver => {
      this.bancoDados.ensureIndex({ fieldName: nomeCampo, ...opcoes }, (erro) => {
        if (erro) {
          this.registrador.error(`Erro ao criar índice: ${erro.message}`);
          resolver(Resultado.falha(erro));
        } else {
          resolver(Resultado.sucesso(true));
        }
      });
    });
  }
}

module.exports = RepositorioNeDB;