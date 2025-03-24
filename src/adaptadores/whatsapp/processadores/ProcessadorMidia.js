/**
 * ProcessadorMidia - Orquestrador central para processamento de mensagens com mídia
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const crypto = require('crypto');

const criarProcessadorMidia = (dependencias) => {
  const { 
    registrador, 
    servicoMensagem,
    // Recebendo os processadores específicos como dependências 
    processadorAudio,
    processadorImagem,
    processadorVideo
  } = dependencias;

  // Infere o MIME type de um buffer de dados
  const inferirMimeType = buffer => {
    if (!buffer || buffer.length < 12) {
      return 'application/octet-stream';
    }

    const bytesHex = buffer.slice(0, 12).toString('hex').toLowerCase();

    // Utilizando compose para criar um pipeline de verificação de tipos
    const verificarTipo = _.cond([
      // Tipos de imagem
      [hex => hex.startsWith('89504e47'), _.constant('image/png')],
      [hex => hex.startsWith('ffd8ff'), _.constant('image/jpeg')],
      [hex => hex.startsWith('47494638'), _.constant('image/gif')],
      [hex => hex.startsWith('424d'), _.constant('image/bmp')],
      [hex => hex.startsWith('52494646') && hex.includes('57454250'), _.constant('image/webp')],

      // Tipos de áudio
      [hex => hex.startsWith('4944330') || hex.startsWith('fffb'), _.constant('audio/mpeg')],
      [hex => hex.startsWith('52494646') && hex.includes('57415645'), _.constant('audio/wav')],
      [hex => hex.startsWith('4f676753'), _.constant('audio/ogg')],

      // Tipos de vídeo
      [hex => hex.includes('66747970'), _.constant('video/mp4')],
      [hex => hex.startsWith('1a45dfa3'), _.constant('video/webm')],
      [hex => hex.startsWith('52494646') && hex.includes('41564920'), _.constant('video/avi')],
      [hex => hex.startsWith('3026b275'), _.constant('video/x-ms-wmv')],

      // Tipo padrão para qualquer outro caso
      [_.stubTrue, _.constant('application/octet-stream')]
    ]);

    return verificarTipo(bytesHex);
  };

  // Processa a mídia e direciona para o processador específico
  // Versão corrigida do ProcessadorMidia.js
const processarMensagemComMidia = async (dados) => {
  const { mensagem, chatId } = dados;

  return Trilho.encadear(
    // Baixar mídia
    () => Trilho.dePromise(mensagem.downloadMedia()),
    
    // Verificar dados e preparar objeto completo
    dadosAnexo => {
      if (!dadosAnexo || !dadosAnexo.data) {
        registrador.error('Não foi possível obter dados de mídia.');
        return Resultado.falha(new Error('Falha ao obter dados de mídia'));
      }

      // Inferir MIME type se necessário
      let mimeType = dadosAnexo.mimetype;
      if (!mimeType) {
        mimeType = inferirMimeType(Buffer.from(dadosAnexo.data, 'base64'));
        dadosAnexo.mimetype = mimeType;
        registrador.info(`MIME inferido: ${mimeType}`);
      }

      // Criar objeto completo com todos os dados necessários
      return Resultado.sucesso({
        mensagem,  
        chatId,
        dadosAnexo, // Importante manter esse objeto!
        mimeType
      });
    },
    
    // Direcionar para o processador adequado com dados completos
    dadosCompletos => {
      const { mimeType } = dadosCompletos;
      
      // Usar cond com dados completos
      const encaminharParaProcessador = _.cond([
        [tipo => tipo.startsWith('audio/'), () => 
          processadorAudio.processarMensagemAudio(dadosCompletos)],
        [tipo => tipo.startsWith('image/'), () => 
          processadorImagem.processarMensagemImagem(dadosCompletos)],
        [tipo => tipo.startsWith('video/'), () => 
          processadorVideo.processarMensagemVideo(dadosCompletos)],
        [_.stubTrue, () => {
          registrador.info(`Tipo de mídia não suportado: ${mimeType}`);
          return Resultado.falha(new Error(`Tipo de mídia não suportado: ${mimeType}`));
        }]
      ]);
      
      return encaminharParaProcessador(mimeType);
    }
  )();
};

  return { 
    processarMensagemComMidia,
    inferirMimeType
  };
};

module.exports = criarProcessadorMidia;