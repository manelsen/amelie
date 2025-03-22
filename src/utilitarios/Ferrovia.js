/**
 * Ferrovia.js - Implementação do Padrão Ferrovia (Railway Pattern)
 * 
 * Fornece utilitários para tratamento funcional de erros e composição.
 * Inspirado pela programação funcional e Either monad.
 * 
 * @author Manel
 */

const _ = require('lodash/fp');

/**
 * Estrutura Resultado para encapsular sucessos e falhas
 */
const Resultado = {
  /**
   * Encapsula um valor de sucesso
   * @param {any} dados - Valor de sucesso
   * @returns {Object} Objeto de resultado com sucesso
   */
  sucesso: (dados) => ({ sucesso: true, dados, erro: null }),

  /**
   * Encapsula um erro
   * @param {Error|string} erro - Erro ou mensagem de erro
   * @returns {Object} Objeto de resultado com falha
   */
  falha: (erro) => ({ 
    sucesso: false, 
    dados: null, 
    erro: erro instanceof Error ? erro : new Error(String(erro))
  }),
  
  /**
   * Transforma os dados de um resultado bem-sucedido
   * @param {Object} resultado - Objeto de resultado
   * @param {Function} fn - Função de transformação
   * @returns {Object} Novo objeto de resultado
   */
  mapear: (resultado, fn) => resultado.sucesso 
    ? Resultado.sucesso(fn(resultado.dados)) 
    : resultado,
  
  /**
   * Encadeia um resultado com uma função que retorna outro resultado
   * @param {Object} resultado - Objeto de resultado
   * @param {Function} fn - Função que retorna um novo resultado
   * @returns {Object} Novo objeto de resultado
   */
  encadear: (resultado, fn) => resultado.sucesso 
    ? fn(resultado.dados) 
    : resultado,
  
  /**
   * Aplica uma de duas funções dependendo do estado do resultado
   * @param {Object} resultado - Objeto de resultado
   * @param {Function} aoSucesso - Função aplicada em caso de sucesso
   * @param {Function} aoFalhar - Função aplicada em caso de falha
   * @returns {any} Valor retornado pela função aplicada
   */
  dobrar: (resultado, aoSucesso, aoFalhar) => 
    resultado.sucesso 
      ? aoSucesso(resultado.dados) 
      : aoFalhar(resultado.erro),
  
  /**
   * Recupera de um erro aplicando uma função de recuperação
   * @param {Object} resultado - Objeto de resultado
   * @param {Function} fn - Função de recuperação que recebe o erro
   * @returns {Object} Novo objeto de resultado
   */
  recuperar: (resultado, fn) => resultado.sucesso
    ? resultado
    : fn(resultado.erro),
      
  /**
   * Combina vários resultados em um único resultado com array de valores
   * @param {Array<Object>} resultados - Array de objetos de resultado
   * @returns {Object} Resultado combinado
   */
  todos: (resultados) => {
    const falha = resultados.find(r => !r.sucesso);
    if (falha) return falha;
    
    return Resultado.sucesso(resultados.map(r => r.dados));
  }
};

/**
 * Utilitários para trabalhar com funções assíncronas seguindo o padrão Ferrovia
 */
const Assync = {
  /**
   * Converte uma Promise em um Resultado
   * @param {Promise} promessa - Promise a ser convertida
   * @returns {Promise<Object>} Promise de um Resultado
   */
  dePromise: (promessa) => 
    promessa
      .then(valor => Resultado.sucesso(valor))
      .catch(erro => Resultado.falha(erro)),
  
  /**
   * Envolve uma função que retorna Promise em uma que retorna Resultado
   * @param {Function} fn - Função que retorna Promise
   * @returns {Function} Função que retorna Promise<Resultado>
   */
  envolver: (fn) => (...args) => 
    Assync.dePromise(fn(...args)),
    
  /**
   * Encadeia operações assíncronas que retornam Resultado
   * @param {Array<Function>} fns - Funções que recebem valor e retornam Promise<Resultado>
   * @returns {Function} Função composta que retorna Promise<Resultado>
   */
  encadear: (...fns) => async (valorInicial) => {
    let resultado = Resultado.sucesso(valorInicial);
    
    for (const fn of fns) {
      if (!resultado.sucesso) break;
      resultado = await fn(resultado.dados);
    }
    
    return resultado;
  }
};

/**
 * Utilitários para trabalhar com operações que podem falhar
 */
const Operacoes = {
  /**
   * Tenta executar uma operação e captura exceções como Resultado
   * @param {Function} fn - Operação a ser executada
   * @returns {Function} Função que retorna um Resultado
   */
  tentar: (fn) => (...args) => {
    try {
      const resultado = fn(...args);
      return resultado instanceof Promise
        ? Assync.dePromise(resultado)
        : Resultado.sucesso(resultado);
    } catch (erro) {
      return Resultado.falha(erro);
    }
  },
  
  /**
   * Verifica uma condição e retorna Resultado.falha se for falsa
   * @param {Function} predicado - Função que retorna boolean
   * @param {string} mensagemErro - Mensagem em caso de falha
   * @returns {Function} Função que retorna um Resultado
   */
  verificar: (predicado, mensagemErro) => (valor) =>
    predicado(valor)
      ? Resultado.sucesso(valor)
      : Resultado.falha(mensagemErro),
      
  /**
   * Tenta executar sequencialmente cada operação até que uma tenha sucesso
   * @param {Array<Function>} operacoes - Operações a tentar
   * @returns {Function} Função que retorna um Resultado
   */
  tentarCada: (operacoes) => async (...args) => {
    let ultimoErro = null;
    
    for (const op of operacoes) {
      try {
        const resultado = op(...args);
        if (resultado instanceof Promise) {
          const resultadoResolvido = await Assync.dePromise(resultado);
          if (resultadoResolvido.sucesso) return resultadoResolvido;
          ultimoErro = resultadoResolvido.erro;
        } else if (resultado.sucesso) {
          return resultado;
        } else {
          ultimoErro = resultado.erro;
        }
      } catch (erro) {
        ultimoErro = erro;
      }
    }
    
    return Resultado.falha(ultimoErro || new Error("Todas as operações falharam"));
  }
};

/**
 * Utilitários para trabalhar com arquivos usando o padrão Ferrovia
 */
const ArquivoUtils = {
  /**
   * Cria um diretório se não existir
   * @param {string} diretorio - Caminho do diretório
   * @returns {Promise<Object>} Resultado com o caminho do diretório
   */
  criarDiretorio: (diretorio) => {
    const fs = require('fs');
    
    if (fs.existsSync(diretorio)) {
      return Promise.resolve(Resultado.sucesso(diretorio));
    }
    
    return new Promise(resolve => {
      fs.mkdir(diretorio, { recursive: true }, (erro) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(diretorio));
        }
      });
    });
  },
  
  /**
   * Verifica se um arquivo existe
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado com boolean indicando existência
   */
  verificarArquivoExiste: (caminho) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.access(caminho, fs.constants.F_OK, (erro) => {
        resolve(Resultado.sucesso(!erro));
      });
    });
  },
  
  /**
   * Salva dados em formato JSON
   * @param {string} caminho - Caminho do arquivo
   * @param {Object} dados - Dados a serem salvos
   * @returns {Promise<Object>} Resultado com o caminho do arquivo
   */
  salvarArquivoJson: (caminho, dados) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.writeFile(caminho, JSON.stringify(dados, null, 2), 'utf8', (erro) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(caminho));
        }
      });
    });
  },
  
  /**
   * Lê um arquivo JSON
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado com os dados do arquivo
   */
  lerArquivoJson: (caminho) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.readFile(caminho, 'utf8', (erro, conteudo) => {
        if (erro) {
          resolve(Resultado.falha(erro));
          return;
        }
        
        try {
          const dados = JSON.parse(conteudo);
          resolve(Resultado.sucesso(dados));
        } catch (erroJson) {
          resolve(Resultado.falha(erroJson));
        }
      });
    });
  },
  
  /**
   * Salva dados binários decodificados de base64
   * @param {string} caminho - Caminho do arquivo
   * @param {string} dadosBase64 - Dados em formato base64
   * @returns {Promise<Object>} Resultado com o caminho do arquivo
   */
  salvarArquivoBinario: (caminho, dadosBase64) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      const buffer = Buffer.from(dadosBase64, 'base64');
      fs.writeFile(caminho, buffer, (erro) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(caminho));
        }
      });
    });
  },
  
  /**
   * Copia um arquivo
   * @param {string} origem - Caminho do arquivo de origem
   * @param {string} destino - Caminho do arquivo de destino
   * @returns {Promise<Object>} Resultado com o caminho do arquivo de destino
   */
  copiarArquivo: (caminho, destino) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.copyFile(caminho, destino, (erro) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(destino));
        }
      });
    });
  },
  
  /**
   * Remove um arquivo
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado indicando sucesso da operação
   */
  removerArquivo: (caminho) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.unlink(caminho, (erro) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(true));
        }
      });
    });
  },
  
  /**
   * Lista arquivos em um diretório
   * @param {string} diretorio - Caminho do diretório
   * @returns {Promise<Object>} Resultado com lista de arquivos
   */
  listarArquivos: (diretorio) => {
    const fs = require('fs');
    
    return new Promise(resolve => {
      fs.readdir(diretorio, (erro, arquivos) => {
        if (erro) {
          resolve(Resultado.falha(erro));
        } else {
          resolve(Resultado.sucesso(arquivos));
        }
      });
    });
  }
};

module.exports = {
  Resultado,
  Assync,
  Operacoes,
  ArquivoUtils
};