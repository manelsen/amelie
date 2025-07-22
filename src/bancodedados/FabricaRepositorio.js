// src/db/FabricaRepositorio.js
/**
 * FabricaRepositorio - Fábrica de repositórios
 * 
 * Centraliza a criação de repositórios, permitindo fácil troca de implementação.
 */

const path = require('path');
const RepositorioNeDB = require('./RepositorioNeDB');
const RepositorioConfiguracao = require('./RepositorioConfiguracao');
const RepositorioTransacoes = require('./RepositorioTransacoes');
const RepositorioPrompts = require('./RepositorioPrompts');
const RepositorioGrupos = require('./RepositorioGrupos');
const RepositorioUsuarios = require('./RepositorioUsuarios');

class FabricaRepositorio {
  /**
   * @param {Object} registrador - Objeto para registro de logs
   * @param {string} diretorioBanco - Diretório base para os bancos de dados
   */
  constructor(registrador, diretorioBanco = path.join(process.cwd(), 'db')) {
    this.registrador = registrador;
    this.diretorioBanco = diretorioBanco;
    this.repositorios = {};
    
    // Mapeamento de tipos de repositório para suas implementações
    this.mapaImplementacoes = {
      'configuracao': RepositorioConfiguracao,
      'transacoes': RepositorioTransacoes,
      'prompts': RepositorioPrompts,
      'grupos': RepositorioGrupos,
      'usuarios': RepositorioUsuarios
    };
  }

  /**
   * Obtém um repositório para uma entidade específica
   * @param {string} nomeEntidade - Nome da entidade (ex: 'configuracao', 'transacoes', etc)
   * @param {boolean} usarImplementacaoEspecifica - Se deve usar implementação específica
   * @returns {Repositorio} Instância do repositório
   */
  obterRepositorio(nomeEntidade, usarImplementacaoEspecifica = true) {
    if (!this.repositorios[nomeEntidade]) {
      const caminhoBanco = path.join(this.diretorioBanco, `${nomeEntidade}.db`);
      
      // Usa implementação específica se disponível e solicitada
      if (usarImplementacaoEspecifica && this.mapaImplementacoes[nomeEntidade]) {
        const ClasseRepositorio = this.mapaImplementacoes[nomeEntidade];
        this.repositorios[nomeEntidade] = new ClasseRepositorio(caminhoBanco, this.registrador);
      } else {
        this.repositorios[nomeEntidade] = new RepositorioNeDB(caminhoBanco, this.registrador);
      }
      
      
    }
    
    return this.repositorios[nomeEntidade];
  }
  
  /**
   * Obtém um repositório de configurações
   * @returns {RepositorioConfiguracao} Repositório de configurações
   */
  obterRepositorioConfiguracao() {
    return this.obterRepositorio('configuracao');
  }
  
  /**
   * Obtém um repositório de transações
   * @returns {RepositorioTransacoes} Repositório de transações
   */
  obterRepositorioTransacoes() {
    return this.obterRepositorio('transacoes');
  }
  
  /**
   * Obtém um repositório de prompts
   * @returns {RepositorioPrompts} Repositório de prompts
   */
  obterRepositorioPrompts() {
    return this.obterRepositorio('prompts');
  }
  
  /**
   * Obtém um repositório de grupos
   * @returns {RepositorioGrupos} Repositório de grupos
   */
  obterRepositorioGrupos() {
    return this.obterRepositorio('grupos');
  }
  
  /**
   * Obtém um repositório de usuários
   * @returns {RepositorioUsuarios} Repositório de usuários
   */
  obterRepositorioUsuarios() {
    return this.obterRepositorio('usuarios');
  }
}

module.exports = FabricaRepositorio;