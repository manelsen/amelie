// src/adaptadores/whatsapp/processadores/ProcessadorTexto.js

const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorTexto = (dependencias) => {
  const {
    registrador,
    adaptadorIA,
    gerenciadorConfig,
    gerenciadorTransacoes,
    servicoMensagem,
    clienteWhatsApp
  } = dependencias;

  const processarMensagemTexto = async (dados) => {
    const { mensagem, chat, chatId } = dados;
    let currentTransacaoId = null; // Initialize for logging in catch block
    registrador.debug(`[Texto] Iniciando processamento.`); // Simplificado

    try { // *** Add robust try...catch block ***
      // Obter informações do remetente
      registrador.debug(`[Texto] Obtendo remetente.`); // Simplificado
      const resultadoRemetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(
          mensagem.author || mensagem.from,
          chat
      );
      if (!resultadoRemetente.sucesso) {
         registrador.error(`[Texto] Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
         throw new Error("Falha ao obter remetente");
      }
      const remetente = resultadoRemetente.dados;
      registrador.debug(`[Texto] Remetente obtido: ${remetente.name}`);

      // Criar transação
      registrador.debug(`[Texto] Criando transação.`); // Simplificado
      const resultadoTransacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      // *** LOG DETALHADO DO RESULTADO DA CRIAÇÃO ***
      registrador.debug(`[Texto] Resultado de criarTransacao: ${JSON.stringify(resultadoTransacao)}`);

      // *** VERIFICAÇÃO ROBUSTA DO RESULTADO ***
      if (!resultadoTransacao || !resultadoTransacao.sucesso) {
           registrador.error(`[Texto] Falha ao criar transação: ${resultadoTransacao?.erro?.message || 'Resultado inválido'}`);
           throw new Error("Falha ao criar transação");
      }

      const transacao = resultadoTransacao.dados;
      // *** LOG CRÍTICO DO ID ANTES DE USAR ***
      registrador.info(`[Texto] Transação criada ${transacao?.id}`); // Simplificado

      // *** VERIFICAÇÃO CRÍTICA DO ID ***
      if (!transacao || !transacao.id) {
          registrador.error("[Texto] *** ERRO CRÍTICO: Objeto transação ou ID está faltando após criação! ***");
          throw new Error("ID da Transação faltando após criação");
      }
      currentTransacaoId = transacao.id; // Assign ID for later use

      // Adicionar dados para recuperação
      registrador.debug(`[Texto] Adicionando dados de recuperação.`); // Simplificado
      await gerenciadorTransacoes.adicionarDadosRecuperacao(
        currentTransacaoId,
        {
          tipo: 'texto',
          remetenteId: mensagem.from,
          remetenteNome: remetente.name,
          chatId: chatId,
          textoOriginal: mensagem.body,
          timestampOriginal: mensagem.timestamp
        }
      );

      // Marcar como processando
      registrador.debug(`[Texto] Marcando como processando.`); // Simplificado
      await gerenciadorTransacoes.marcarComoProcessando(currentTransacaoId);

      // Obter histórico e configuração
      registrador.debug(`[Texto] Obtendo histórico e config.`); // Simplificado
      const historico = await clienteWhatsApp.obterHistoricoMensagens(chatId);
      const config = await gerenciadorConfig.obterConfig(chatId);

      // ... (formatar histórico - código omitido por brevidade) ...
      const ultimaMensagem = historico.length > 0 ? historico[historico.length - 1] : '';
      const mensagemUsuarioAtual = `${remetente.name}: ${mensagem.body}`;
      const textoHistorico = ultimaMensagem.includes(mensagem.body)
        ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}`
        : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${historico.join('\n')}\n${mensagemUsuarioAtual}`;


      // Processar com IA
      registrador.debug(`[Texto] Chamando IA (processarTexto).`); // Simplificado
      const resultadoResposta = await adaptadorIA.processarTexto(textoHistorico, config);
      if (!resultadoResposta.sucesso) {
          registrador.error(`[Texto] Falha na IA: ${resultadoResposta.erro.message}`); // Simplificado
          await gerenciadorTransacoes.registrarFalhaEntrega(currentTransacaoId, `Falha IA: ${resultadoResposta.erro.message}`); // Registrar falha
          throw new Error(`Falha IA: ${resultadoResposta.erro.message}`); // Lançar para catch
      }
      const resposta = resultadoResposta.dados;
      registrador.info(`[Texto] Resposta da IA recebida. Tamanho: ${resposta?.length}`); // Simplificado

      // Adicionar resposta à transação
      registrador.debug(`[Texto] Adicionando resposta à transação.`); // Simplificado
      await gerenciadorTransacoes.adicionarRespostaTransacao(currentTransacaoId, resposta);

      // Enviar a resposta
      registrador.debug(`[Texto] Enviando resposta.`); // Simplificado
      await servicoMensagem.enviarResposta(mensagem, resposta, currentTransacaoId);
      registrador.info(`[Texto] Resposta enviada.`); // Simplificado

      // 'marcarComoEntregue' é provavelmente tratado por servicoMensagem

      return Resultado.sucesso({ transacao, resposta });

    } catch (erro) { // Catch block robusto
      registrador.error(`[Texto] ERRO GERAL: ${erro.message}`, erro); // Simplificado
      // Tentar registrar falha se tivermos ID
      if (currentTransacaoId) {
          try {
              await gerenciadorTransacoes.registrarFalhaEntrega(currentTransacaoId, `Erro: ${erro.message}`);
          } catch (e) { registrador.error(`[Texto] Falha ao registrar erro na transação: ${e.message}`); }
      }
      // Tentar enviar feedback de erro
      try {
          await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro ao processar sua mensagem de texto.');
      } catch (e) { registrador.error(`[Texto] Falha ao enviar feedback de erro: ${e.message}`); }
      return Resultado.falha(erro);
    }
  }; // Fim de processarMensagemTexto

  return { processarMensagemTexto };
};

module.exports = criarProcessadorTexto;
