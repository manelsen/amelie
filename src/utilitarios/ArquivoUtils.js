/**
 * ArquivoUtils - Utilitários para manipulação de arquivos
 * 
 * Implementa operações de arquivo usando o padrão Ferrovia (Railway).
 * Todas as funções retornam Promises com Resultado.
 */

const fs = require('fs');
const path = require('path');
const _ = require('lodash/fp');
const { Resultado } = require('../bancodedados/Repositorio');

/**
 * Cria um diretório se ele não existir
 * @param {string} diretorio - Caminho do diretório
 * @returns {Promise<Resultado>} Resultado com o caminho do diretório
 */
const criarDiretorio = (diretorio) => {
  return new Promise((resolve) => {
    if (fs.existsSync(diretorio)) {
      resolve(Resultado.sucesso(diretorio));
      return;
    }
    
    fs.mkdir(diretorio, { recursive: true }, (erro) => {
      if (erro) {
        resolve(Resultado.falha(erro));
      } else {
        resolve(Resultado.sucesso(diretorio));
      }
    });
  });
};

/**
 * Verifica se um arquivo existe
 * @param {string} caminho - Caminho do arquivo
 * @returns {Promise<Resultado>} Resultado indicando se o arquivo existe
 */
const verificarArquivoExiste = (caminho) => {
  return new Promise((resolve) => {
    fs.access(caminho, fs.constants.F_OK, (erro) => {
      resolve(Resultado.sucesso(!erro));
    });
  });
};

/**
 * Salva dados em formato JSON
 * @param {string} caminho - Caminho do arquivo
 * @param {Object} dados - Dados a serem salvos
 * @returns {Promise<Resultado>} Resultado com o caminho do arquivo
 */
const salvarArquivoJson = (caminho, dados) => {
  return new Promise((resolve) => {
    fs.writeFile(caminho, JSON.stringify(dados, null, 2), 'utf8', (erro) => {
      if (erro) {
        resolve(Resultado.falha(erro));
      } else {
        resolve(Resultado.sucesso(caminho));
      }
    });
  });
};

/**
 * Salva dados binários decodificados de base64
 * @param {string} caminho - Caminho do arquivo
 * @param {string} dadosBase64 - Dados em formato base64
 * @returns {Promise<Resultado>} Resultado com o caminho do arquivo
 */
const salvarArquivoBinario = (caminho, dadosBase64) => {
  return new Promise((resolve) => {
    const buffer = Buffer.from(dadosBase64, 'base64');
    fs.writeFile(caminho, buffer, (erro) => {
      if (erro) {
        resolve(Resultado.falha(erro));
      } else {
        resolve(Resultado.sucesso(caminho));
      }
    });
  });
};

/**
 * Copia um arquivo
 * @param {string} origem - Caminho do arquivo de origem
 * @param {string} destino - Caminho do arquivo de destino
 * @returns {Promise<Resultado>} Resultado com o caminho do arquivo de destino
 */
const copiarArquivo = (origem, destino) => {
  return new Promise((resolve) => {
    fs.copyFile(origem, destino, (erro) => {
      if (erro) {
        resolve(Resultado.falha(erro));
      } else {
        resolve(Resultado.sucesso(destino));
      }
    });
  });
};

/**
 * Salva conteúdo bloqueado por safety para auditoria
 * @param {string} tipo - Tipo de conteúdo ('imagem' ou 'video')
 * @param {string} diretorioBase - Diretório para salvar os arquivos
 * @param {Object} dados - Dados do conteúdo bloqueado
 * @param {Object} erro - Erro de safety
 * @returns {Promise<Resultado>} Resultado com caminhos dos arquivos salvos
 */
const salvarConteudoBloqueado = _.curry((tipo, diretorioBase, dados, erro) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nomeArquivoJson = `${tipo}_blocked_${timestamp}.json`;
  const nomeArquivoMidia = `${tipo}_blocked_${timestamp}${tipo === 'video' ? '.mp4' : '.bin'}`;
  const caminhoJson = path.join(diretorioBase, nomeArquivoJson);
  const caminhoMidia = path.join(diretorioBase, nomeArquivoMidia);
  
  return criarDiretorio(diretorioBase)
    .then(resultado => {
      if (!resultado.sucesso) {
        return Resultado.falha(resultado.erro);
      }
      
      // Preparar metadados
      const metadados = {
        timestamp,
        origemInfo: dados.origemInfo || null,
        erro: erro.message,
        prompt: dados.prompt,
        mimeType: dados.mimeType,
        arquivoSalvo: nomeArquivoMidia
      };
      
      // Diferentes salvamentos dependendo do tipo
      const salvarMidia = tipo === 'video'
        ? verificarArquivoExiste(dados.caminhoVideo)
            .then(resultado => {
              if (!resultado.sucesso || !resultado.dados) {
                return Resultado.sucesso(false); // Arquivo não existe, mas não é erro crítico
              }
              return copiarArquivo(dados.caminhoVideo, caminhoMidia);
            })
        : salvarArquivoBinario(caminhoMidia, dados.imagemData.data);
      
      // Salvar ambos os arquivos
      return Promise.all([
        salvarArquivoJson(caminhoJson, metadados),
        salvarMidia
      ])
      .then(() => Resultado.sucesso({
        caminhoJson,
        caminhoMidia,
        tipo
      }))
      .catch(erro => Resultado.falha(erro));
    });
});

module.exports = {
  criarDiretorio,
  verificarArquivoExiste,
  salvarArquivoJson,
  salvarArquivoBinario,
  copiarArquivo,
  salvarConteudoBloqueado
};