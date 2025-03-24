/**
 * ProcessadorImagem - Processamento específico para mensagens com imagens
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorImagem = (dependencias) => {
  const { 
    registrador, 
    gerenciadorConfig, 
    gerenciadorTransacoes, 
    servicoMensagem, 
    filasMidia, 
    clienteWhatsApp 
  } = dependencias;

  const processarMensagemImagem = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
  
    try {
      // Obter chat
      const chat = await mensagem.getChat();
      
      // Obter configuração
      const config = await gerenciadorConfig.obterConfig(chatId);
      
      // Verificar se descrição de imagem está habilitada
      if (!config.mediaImage) {
        registrador.debug(`Descrição de imagem desabilitada para o chat ${chatId}. Ignorando mensagem de imagem.`);
        return Resultado.falha(new Error("Descrição de imagem desabilitada"));
      }
      
      // Obter informações do remetente de forma direta
      const resultadoRemetente = await obterOuCriarUsuario(
        gerenciadorConfig, 
        clienteWhatsApp, 
        registrador
      )(mensagem.author || mensagem.from, chat);
      
      if (!resultadoRemetente.sucesso) {
        registrador.error(`Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
        return resultadoRemetente;
      }
      
      const remetente = resultadoRemetente.dados;
      registrador.debug(`Remetente encontrado: ${remetente.name}`);
      
      // Preparar dados de origem
      const dadosOrigem = {
        id: chat.id._serialized,
        nome: chat.isGroup ? chat.name : remetente.name,
        tipo: chat.isGroup ? 'grupo' : 'usuario',
        remetenteId: mensagem.author || mensagem.from,
        remetenteNome: remetente.name
      };
      
      // Criar transação
      const transacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`Nova transação criada: ${transacao.id} para mensagem de imagem de ${remetente.name}`);
      
      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      
      // Determinar prompt do usuário
      let promptUsuario = "";
      if (mensagem.body && mensagem.body.trim() !== '') {
        promptUsuario = mensagem.body.trim();
      }
      
      // Adicionar à fila de processamento
      await filasMidia.adicionarImagem({
        imageData: dadosAnexo,
        chatId,
        messageId: mensagem.id._serialized,
        mimeType: dadosAnexo.mimetype,
        userPrompt: promptUsuario,
        senderNumber: mensagem.from,
        transacaoId: transacao.id,
        remetenteName: remetente.name,
        modoDescricao: config.modoDescricao || 'curto',
        dadosOrigem: dadosOrigem
      });
      
      registrador.debug(`🚀 Imagem de ${remetente.name} adicionada à fila com sucesso (transação ${transacao.id})`);
      return Resultado.sucesso({ transacao });
      
    } catch (erro) {
      registrador.error(`Erro ao processar mensagem de imagem: ${erro.message}`);
      
      // Verificar se é um erro de segurança
      if (erro.message.includes('SAFETY') || erro.message.includes('safety') ||
          erro.message.includes('blocked') || erro.message.includes('Blocked')) {
        
        registrador.warn(`⚠️ Conteúdo de imagem bloqueado por políticas de segurança`);
        
        try {
          await servicoMensagem.enviarResposta(
            mensagem, 
            'Este conteúdo não pôde ser processado por questões de segurança.'
          );
        } catch (erroEnvio) {
          registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
        }
      } else {
        try {
          await servicoMensagem.enviarResposta(
            mensagem, 
            'Desculpe, ocorreu um erro ao processar sua imagem.'
          );
        } catch (erroEnvio) {
          registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
        }
      }
      
      return Resultado.falha(erro);
    }
  };

  return { processarMensagemImagem };
};

module.exports = criarProcessadorImagem;