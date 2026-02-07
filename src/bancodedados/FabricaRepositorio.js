// src/bancodedados/FabricaRepositorio.js
/**
 * FabricaRepositorio - Fábrica de repositórios (Funcional)
 * 
 * Centraliza a criação de repositórios, permitindo fácil troca de implementação.
 */

const path = require('path');
const { criarRepositorioNeDB } = require('./RepositorioNeDB');
const { criarRepositorioConfiguracao } = require('./RepositorioConfiguracao');
const { criarRepositorioTransacoes } = require('./RepositorioTransacoes');
const { criarRepositorioPrompts } = require('./RepositorioPrompts');
const { criarRepositorioGrupos } = require('./RepositorioGrupos');
const { criarRepositorioUsuarios } = require('./RepositorioUsuarios');

/**
 * Cria uma fábrica de repositórios
 * @param {Object} registrador - Objeto para registro de logs
 * @param {string} diretorioBanco - Diretório base para os bancos de dados
 * @returns {Object} Instância funcional da fábrica
 */
const criarFabricaRepositorio = (registrador, diretorioBanco = path.join(process.cwd(), 'db')) => {
  const repositorios = {};
  
  // Mapeamento de nomes para fábricas
  const mapaFabricas = {
    'configuracao': criarRepositorioConfiguracao,
    'transacoes': criarRepositorioTransacoes,
    'prompts': criarRepositorioPrompts,
    'grupos': criarRepositorioGrupos,
    'usuarios': criarRepositorioUsuarios
  };

  /**
   * Obtém um repositório para uma entidade específica
   */
  const obterRepositorio = (nomeEntidade, usarImplementacaoEspecifica = true) => {
    if (!repositorios[nomeEntidade]) {
      const caminhoBanco = path.join(diretorioBanco, `${nomeEntidade}.db`);
      
      if (usarImplementacaoEspecifica && mapaFabricas[nomeEntidade]) {
        const fabrica = mapaFabricas[nomeEntidade];
        repositorios[nomeEntidade] = fabrica(caminhoBanco, registrador);
      } else {
        repositorios[nomeEntidade] = criarRepositorioNeDB(caminhoBanco, registrador);
      }
    }
    
    return repositorios[nomeEntidade];
  };
  
  return {
    obterRepositorio,
    obterRepositorioConfiguracao: () => obterRepositorio('configuracao'),
    obterRepositorioTransacoes: () => obterRepositorio('transacoes'),
    obterRepositorioPrompts: () => obterRepositorio('prompts'),
    obterRepositorioGrupos: () => obterRepositorio('grupos'),
    obterRepositorioUsuarios: () => obterRepositorio('usuarios')
  };
};

module.exports = { criarFabricaRepositorio };
