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
    processadorVideo,
    processadorDocumento // Usar o processador generalizado
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
      [hex => hex.includes('66747970'), _.constant('video/mp4')], // ftyp
      [hex => hex.startsWith('1a45dfa3'), _.constant('video/webm')], // EBML
      [hex => hex.startsWith('52494646') && hex.includes('41564920'), _.constant('video/avi')], // RIFF AVI
      [hex => hex.startsWith('3026b275'), _.constant('video/x-ms-wmv')], // ASF/WMV

      // Tipos de Documento (Adicionar mais se necessário, mas confiar no mimetype da mensagem primeiro)
      [hex => hex.startsWith('25504446'), _.constant('application/pdf')], // %PDF
      // Outros tipos de texto (TXT, HTML, CSV, XML, MD, RTF) são difíceis de detectar confiavelmente por magic bytes.
      // Confiaremos no mimetype fornecido pela mensagem para esses.

      // Tipo padrão para qualquer outro caso
      [_.stubTrue, _.constant('application/octet-stream')] // Fallback
    ]);

    return verificarTipo(bytesHex);
  };

  // Processa a mídia e direciona para o processador específico
  // Versão corrigida do ProcessadorMidia.js
  const processarMensagemComMidia = async (dados) => {
    const { mensagem, chatId } = dados;
  
    try {
      // Baixar mídia de forma direta, sem usar o Trilho ainda
      const dadosAnexo = await mensagem.downloadMedia();
      
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
  
      // Direcionar para o processador adequado com base no tipo MIME
      if (mimeType.startsWith('audio/')) {
        return await processadorAudio.processarMensagemAudio({ mensagem, chatId, dadosAnexo });
      } else if (mimeType.startsWith('image/')) {
        return await processadorImagem.processarMensagemImagem({ mensagem, chatId, dadosAnexo });
      } else if (mimeType.startsWith('video/')) {
        return await processadorVideo.processarMensagemVideo({ mensagem, chatId, dadosAnexo });
      } else if (
        mimeType === 'application/pdf' ||
        mimeType === 'text/plain' ||
        mimeType === 'text/html' ||
        mimeType === 'text/markdown' || // WhatsApp pode não enviar este, mas adicionamos por segurança
        mimeType === 'text/csv' ||
        mimeType === 'text/xml' || // WhatsApp pode não enviar este
        mimeType === 'application/rtf' || // Mimetype comum para RTF
        mimeType === 'text/rtf' ||
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || // *** Adicionar DOCX ***
        mimeType === 'application/octet-stream' // Manter octet-stream como fallback
      ) {
        // Log simplificado (confirmando [Midia])
        const logMsg = (mimeType === 'application/octet-stream')
          ? `[Midia] Direcionando documento (octet-stream) para processamento.`
          : `[Midia] Direcionando documento (${mimeType}) para processamento.`;
        registrador.info(logMsg);
        return await processadorDocumento.processarMensagemDocumento({ mensagem, chatId, dadosAnexo });
      } else {
        // Este bloco agora só será atingido por tipos explicitamente não listados (e não octet-stream)
        registrador.warn(`[Midia] Tipo não suportado: ${mimeType}`); // Simplificado
        // Informar o usuário que o tipo não é suportado - Usar enviarMensagemDireta
        try {
          await servicoMensagem.enviarMensagemDireta(chatId, `⚠️ Desculpe, ainda não consigo processar arquivos do tipo "${mimeType}".`);
        } catch (errEnvio) {
          // O erro já foi logado por enviarMensagemDireta, apenas registrar contexto adicional se necessário
          registrador.error(`[Midia] Falha crítica ao notificar tipo não suportado: ${errEnvio.message}`); // Simplificado
        }
        return Resultado.falha(new Error(`Tipo de mídia não suportado: ${mimeType}`));
      }
    } catch (erro) {
      registrador.error(`Erro ao processar mídia: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };

  return { 
    processarMensagemComMidia,
    inferirMimeType
  };
};

module.exports = criarProcessadorMidia;
