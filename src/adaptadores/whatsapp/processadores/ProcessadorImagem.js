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
    

    try { // Bloco try principal
      // Obter chat
      const chat = await mensagem.getChat();

      // Obter configuração
      
      const config = await gerenciadorConfig.obterConfig(chatId);
      


      // Verificar se descrição de imagem está habilitada
      if (!config || !config.mediaImage) {
        
        return Resultado.falha(new Error("Descrição de imagem desabilitada"));
      }
      


      // Obter informações do remetente
      
      const resultadoRemetente = await obterOuCriarUsuario(
        gerenciadorConfig,
        clienteWhatsApp,
        registrador
      )(mensagem.author || mensagem.from, chat);

      if (!resultadoRemetente.sucesso) {
        registrador.error(`[Image] Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
        throw new Error("Falha ao obter remetente");
      }
      const remetente = resultadoRemetente.dados;
      


      // Preparar dados de origem
      const dadosOrigem = {
        id: chat.id._serialized,
        nome: chat.isGroup ? chat.name : remetente.name,
        tipo: chat.isGroup ? 'grupo' : 'usuario',
        remetenteId: mensagem.author || mensagem.from,
        remetenteNome: remetente.name
      };

      // --- Bloco Corrigido de Criação e Verificação da Transação ---
      
      const resultadoTransacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      

      if (!resultadoTransacao || !resultadoTransacao.sucesso) {
           registrador.error(`[Image] Falha ao criar transação: ${resultadoTransacao?.erro?.message || 'Resultado inválido/inesperado'}`);
           try {
               await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro interno ao iniciar o processamento.');
           } catch(e) { registrador.error(`[Image] Falha ao enviar erro sobre criarTransacao: ${e.message}`)}
           return Resultado.falha(resultadoTransacao?.erro || new Error("Falha ao criar transação"));
      }

      const transacao = resultadoTransacao.dados;
      registrador.info(`[Image] Transação criada ${transacao?.id}`); // Simplificado

      if (!transacao || !transacao.id) {
          registrador.error("[Image] *** ERRO CRÍTICO: Objeto transação ou ID está faltando após criação! ***");
          try {
              await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro crítico ao registrar o processamento (ID faltando).');
          } catch(e) { registrador.error(`[Image] Falha ao enviar erro sobre ID faltando: ${e.message}`)}
          return Resultado.falha(new Error("ID da Transação faltando após criação"));
      }

      currentTransacaoId = transacao.id; // Armazena o ID validado
      
      // --- Fim do Bloco Corrigido ---

      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(currentTransacaoId); // Usar ID validado
      

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
        transacaoId: currentTransacaoId, // Passar ID validado
        remetenteName: remetente.name,
        modoDescricao: config.modoDescricao || 'curto',
        dadosOrigem: dadosOrigem
      });

      
      return Resultado.sucesso({ transacao }); // Retorna o objeto transacao original

    } catch (erro) { // Catch geral
      registrador.error(`[Image] ERRO GERAL: ${erro.message}`, erro); // Simplificado

      // Registrar falha na transação se ID existe
       if (currentTransacaoId) {
           try {
               await gerenciadorTransacoes.registrarFalhaEntrega(currentTransacaoId, `Erro processamento imagem: ${erro.message}`);
           } catch (e) { registrador.error(`[Image] Falha ao registrar erro na transação: ${e.message}`); }
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
             registrador.error(`[Image] Falha ao enviar mensagem de erro geral: ${erroEnvio.message}`);
          }
       }
      return Resultado.falha(erro);
    }
  }; // Fim de processarMensagemImagem

  return { processarMensagemImagem };
};

module.exports = criarProcessadorImagem;
