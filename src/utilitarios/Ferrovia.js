/**
 * Ferrovia.js - Implementação do Padrão Ferrovia (Railway Pattern)
 * 
 * Fornece utilitários para tratamento funcional de erros e composição.
 * Inspirado pela programação funcional e Either monad.
 * 
 * @author Manel
 */

const _ = require('lodash/fp');
const fs = require('fs').promises; // Importação única de fs.promises

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
const Trilho = {
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
    Trilho.dePromise(fn(...args)),
    
  /**
   * Encadeia operações assíncronas que retornam Resultado
   * @param {Array<Function>} fns - Funções que recebem valor e retornam Promise<Resultado>
   * @returns {Function} Função composta que retorna Promise<Resultado>
   */
  encadear: (...fns) => async (valorInicial) => {
    let resultado = Resultado.sucesso(valorInicial);
    
    for (const fn of fns) {
      if (!resultado.sucesso) break; // Mantém o primeiro erro
      
      // Executa a próxima função e trata o resultado
      let proximoResultado;
      const nomeEtapaLog = fn.name || 'anônima'; // Para logs
      try {
        // console.log(`[Trilho.encadear] Executando etapa: ${nomeEtapaLog}`); // Log removido
        proximoResultado = await fn(resultado.dados);
        // console.log(`[Trilho.encadear] Etapa ${nomeEtapaLog} concluída. Sucesso: ${proximoResultado?.sucesso}`); // Log removido
      } catch (erroEtapa) {
        // Transforma a exceção em um Resultado.falha para que o trilho pare corretamente
        // Log removido
        // Transforma a exceção em um Resultado.falha para que o trilho pare corretamente
        proximoResultado = Resultado.falha(new Error(`Erro inesperado na execução da etapa '${nomeEtapaLog}': ${erroEtapa.message}`));
      }
      
      if (!proximoResultado || typeof proximoResultado.sucesso !== 'boolean') {
        // Se o resultado não for um objeto Resultado válido, tratar como falha
        const nomeEtapa = fn.name || 'etapa desconhecida';
        const erroInvalido = new Error(`Resultado inválido retornado pela etapa '${nomeEtapa}'.`);
        resultado = Resultado.falha(erroInvalido); // Define como falha e quebra
        break;
      }
      
      if (!proximoResultado.sucesso) {
        // Falha na etapa atual: envolve o erro com contexto
        const erroOriginal = proximoResultado.erro;
        const nomeEtapa = fn.name || 'etapa desconhecida';
        const erroComContexto = new Error(`Falha na etapa '${nomeEtapa}': ${erroOriginal.message}`);
        erroComContexto.causaOriginal = erroOriginal; // Anexa o erro original
        // Define o resultado como a falha contextualizada e interrompe o loop
        resultado = Resultado.falha(erroComContexto);
        break;
      }
      
      // Sucesso na etapa atual: atualiza o resultado para a próxima iteração
      resultado = proximoResultado;
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
        ? Trilho.dePromise(resultado)
        : Resultado.sucesso(resultado);
    } catch (erroOriginal) {
      // Exceção capturada: envolve o erro com contexto
      const nomeFuncao = fn.name || 'função desconhecida';
      const erroComContexto = new Error(`Erro ao tentar executar '${nomeFuncao}': ${erroOriginal.message}`);
      erroComContexto.causaOriginal = erroOriginal; // Anexa o erro original
      return Resultado.falha(erroComContexto);
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
          const resultadoResolvido = await Trilho.dePromise(resultado);
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
  // Usa Operacoes.tentar para envolver a chamada async
  criarDiretorio: Operacoes.tentar(async (diretorio) => {
    // fs.mkdir com recursive: true é idempotente (não falha se já existe)
    await fs.mkdir(diretorio, { recursive: true });
    return diretorio; // Retorna o diretório em caso de sucesso
  }),
  
  /**
   * Verifica se um arquivo existe
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado com boolean indicando existência
   */
  // Usa Operacoes.tentar para envolver a chamada async
  verificarArquivoExiste: Operacoes.tentar(async (caminho) => {
    await fs.access(caminho, fs.constants.F_OK);
    return true; // Retorna true se o acesso foi bem-sucedido (arquivo existe)
  }),
  // Nota: Se fs.access falhar (arquivo não existe ou sem permissão),
  // Operacoes.tentar retornará Resultado.falha(erro).
  // Se precisar distinguir "não existe" de "sem permissão", um try/catch seria necessário.
  // Para um simples "existe?", este comportamento é geralmente aceitável,
  // mas pode ser necessário ajustar dependendo do uso.
  // Uma alternativa que retorna Resultado<boolean, Error>:
  // verificarArquivoExiste: async (caminho) => {
  //   try {
  //     await fs.access(caminho, fs.constants.F_OK);
  //     return Resultado.sucesso(true);
  //   } catch (erro) {
  //     if (erro.code === 'ENOENT') {
  //       return Resultado.sucesso(false); // Arquivo não existe é um sucesso neste contexto
  //     }
  //     return Resultado.falha(erro); // Outro erro (permissão, etc.)
  //   }
  // },
  
  /**
   * Salva dados em formato JSON
   * @param {string} caminho - Caminho do arquivo
   * @param {Object} dados - Dados a serem salvos
   * @returns {Promise<Object>} Resultado com o caminho do arquivo
   */
  // Usa Operacoes.tentar para envolver a chamada async
  salvarArquivoJson: Operacoes.tentar(async (caminho, dados) => {
    const conteudoJson = JSON.stringify(dados, null, 2);
    await fs.writeFile(caminho, conteudoJson, 'utf8');
    return caminho; // Retorna o caminho em caso de sucesso
  }),
  
  /**
   * Lê um arquivo JSON
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado com os dados do arquivo
   */
  // Usa Operacoes.tentar para envolver a chamada async e o JSON.parse
  lerArquivoJson: Operacoes.tentar(async (caminho) => {
    const conteudo = await fs.readFile(caminho, 'utf8');
    const dados = JSON.parse(conteudo); // O erro de parse será capturado por Operacoes.tentar
    return dados; // Retorna os dados parseados em caso de sucesso
  }),
  
  /**
   * Salva dados binários decodificados de base64
   * @param {string} caminho - Caminho do arquivo
   * @param {string} dadosBase64 - Dados em formato base64
   * @returns {Promise<Object>} Resultado com o caminho do arquivo
   */
  // Usa Operacoes.tentar para envolver a chamada async
  salvarArquivoBinario: Operacoes.tentar(async (caminho, dadosBase64) => {
    const buffer = Buffer.from(dadosBase64, 'base64');
    await fs.writeFile(caminho, buffer);
    return caminho; // Retorna o caminho em caso de sucesso
  }),
  
  /**
   * Copia um arquivo
   * @param {string} origem - Caminho do arquivo de origem
   * @param {string} destino - Caminho do arquivo de destino
   * @returns {Promise<Object>} Resultado com o caminho do arquivo de destino
   */
  // Usa Operacoes.tentar para envolver a chamada async
  // Renomeado parâmetro 'caminho' para 'origem' para clareza
  copiarArquivo: Operacoes.tentar(async (origem, destino) => {
    await fs.copyFile(origem, destino);
    return destino; // Retorna o destino em caso de sucesso
  }),
  
  /**
   * Remove um arquivo
   * @param {string} caminho - Caminho do arquivo
   * @returns {Promise<Object>} Resultado indicando sucesso da operação
   */
  // Usa Operacoes.tentar para envolver a chamada async
  removerArquivo: Operacoes.tentar(async (caminho) => {
    await fs.unlink(caminho);
    return true; // Retorna true em caso de sucesso
  }),
  
  /**
   * Lista arquivos em um diretório
   * @param {string} diretorio - Caminho do diretório
   * @returns {Promise<Object>} Resultado com lista de arquivos
   */
  // Usa Operacoes.tentar para envolver a chamada async
  listarArquivos: Operacoes.tentar(async (diretorio) => {
    const arquivos = await fs.readdir(diretorio);
    return arquivos; // Retorna a lista de arquivos em caso de sucesso
  })
};

module.exports = {
  Resultado,
  Trilho,
  Operacoes,
  ArquivoUtils
};