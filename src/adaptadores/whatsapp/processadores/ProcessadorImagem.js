/**
 * ProcessadorImagem - Processamento específico para mensagens com imagens
 */
const _ = require('lodash/fp');
const { Resultado } = require('../../../utilitarios/Ferrovia'); // Apenas Resultado necessário
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
    let currentTransacaoId = null; // Inicializa para log no catch
    registrador.debug(`[Imagem] Iniciando para msg ${mensagem.id._serialized} no chat ${chatId}`);

    try { // Bloco try principal
      // Obter chat
      const chat = await mensagem.getChat();

      // Obter configuração
      registrador.debug(`[Imagem] Obtendo config para ${chatId}...`);
      const config = await gerenciadorConfig.obterConfig(chatId);
      registrador.debug(`[Imagem] Config obtida para ${chatId}: mediaImage=${config?.mediaImage}`);


      // Verificar se descrição de imagem está habilitada
      if (!config || !config.mediaImage) {
        registrador.info(`[Imagem] Descrição de imagem DESABILITADA para ${chatId}. Ignorando.`);
        return Resultado.falha(new Error("Descrição de imagem desabilitada"));
      }
      registrador.debug(`[Imagem] Descrição HABILITADA para ${chatId}. Continuando...`);


      // Obter informações do remetente
      registrador.debug(`[Imagem] Obtendo remetente para ${chatId}...`);
      const resultadoRemetente = await obterOuCriarUsuario(
        gerenciadorConfig,
        clienteWhatsApp,
        registrador
      )(mensagem.author || mensagem.from, chat);

      if (!resultadoRemetente.sucesso) {
        registrador.error(`[Imagem] Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
        throw new Error("Falha ao obter remetente");
      }
      const remetente = resultadoRemetente.dados;
      registrador.debug(`[Imagem] Remetente obtido: ${remetente.name}`);


      // Preparar dados de origem
      const dadosOrigem = {
        id: chat.id._serialized,
        nome: chat.isGroup ? chat.name : remetente.name,
        tipo: chat.isGroup ? 'grupo' : 'usuario',
        remetenteId: mensagem.author || mensagem.from,
        remetenteNome: remetente.name
      };

      // --- Bloco Corrigido de Criação e Verificação da Transação ---
      registrador.debug(`[Imagem] Criando transação para ${chatId}...`);
      const resultadoTransacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`[Imagem] Resultado de criarTransacao: ${JSON.stringify(resultadoTransacao)}`);

      if (!resultadoTransacao || !resultadoTransacao.sucesso) {
           registrador.error(`[Imagem] Falha ao criar transação: ${resultadoTransacao?.erro?.message || 'Resultado inválido/inesperado'}`);
           try {
               await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro interno ao iniciar o processamento.');
           } catch(e) { registrador.error(`[Imagem] Falha ao enviar erro sobre criarTransacao: ${e.message}`)}
           return Resultado.falha(resultadoTransacao?.erro || new Error("Falha ao criar transação"));
      }

      const transacao = resultadoTransacao.dados;
      registrador.info(`[Imagem] Transação ${transacao?.id ? 'criada com id' : 'criada sem id (!)'}. ID: ${transacao?.id}`);

      if (!transacao || !transacao.id) {
          registrador.error("[Imagem] *** ERRO CRÍTICO: Objeto transação ou ID está faltando após criação bem-sucedida! ***");
          try {
              await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro crítico ao registrar o processamento (ID faltando).');
          } catch(e) { registrador.error(`[Imagem] Falha ao enviar erro sobre ID faltando: ${e.message}`)}
          return Resultado.falha(new Error("ID da Transação faltando após criação"));
      }

      currentTransacaoId = transacao.id; // Armazena o ID validado
      registrador.debug(`[Imagem] ID da transação ${currentTransacaoId} validado. Continuando processamento...`);
      // --- Fim do Bloco Corrigido ---

      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(currentTransacaoId); // Usar ID validado
      registrador.debug(`[Imagem] Transação ${currentTransacaoId} marcada como processando.`);

      // Determinar prompt do usuário
      let promptUsuario = "";
      if (mensagem.body && mensagem.body.trim() !== '') {
        promptUsuario = mensagem.body.trim();
      }

      // Adicionar à fila de processamento
      registrador.info(`[Imagem] Adicionando job à fila para ${chatId} com transacaoId: ${currentTransacaoId}`);
      await filasMidia.adicionarImagem({
        imageData: dadosAnexo,
        chatId,
        messageId: mensagem.id._serialized,
        mimeType: dadosAnexo.mimetype,
        userPrompt: promptUsuario,
        senderNumber: mensagem.from,
        transacaoId: currentTransacaoId, // Passar ID validado
        remetenteName: remetente.name,
        modoDescricao: config.modoDescricao || 'curto',
        dadosOrigem: dadosOrigem
      });

      registrador.debug(`[Imagem] Imagem de ${remetente.name} adicionada à fila com transacaoId ${currentTransacaoId}`);
      return Resultado.sucesso({ transacao }); // Retorna o objeto transacao original

    } catch (erro) { // Catch geral
      registrador.error(`[Imagem] ERRO GERAL para msg ${mensagem?.id?._serialized} / chat ${chatId} / transação ${currentTransacaoId}: ${erro.message}`, erro);

      // Registrar falha na transação se ID existe
       if (currentTransacaoId) {
           try {
               await gerenciadorTransacoes.registrarFalhaEntrega(currentTransacaoId, `Erro processamento imagem: ${erro.message}`);
           } catch (e) { registrador.error(`[Imagem] Falha ao registrar erro na transação ${currentTransacaoId}: ${e.message}`); }
       }

      // Enviar feedback genérico de erro, exceto se já foi tratado (segurança) ou se estava desabilitado
      const msgErroLower = erro.message?.toLowerCase() || "";
       if (!msgErroLower.includes('desabilitada') && !msgErroLower.includes('segurança')) {
          try {
             await servicoMensagem.enviarResposta(
                mensagem,
                'Desculpe, ocorreu um erro inesperado ao tentar processar a imagem.'
             );
          } catch (erroEnvio) {
             registrador.error(`[Imagem] Falha ao enviar mensagem de erro geral: ${erroEnvio.message}`);
          }
       }
      return Resultado.falha(erro);
    }
  }; // Fim de processarMensagemImagem

  return { processarMensagemImagem };
};

module.exports = criarProcessadorImagem;