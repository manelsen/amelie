/**
 * ProcessadorComandos - Processamento de mensagens de comando
 */
const _ = require('lodash/fp');
const { Resultado, Trilho, Operacoes } = require('../../../utilitarios/Ferrovia');
// verificarPermissaoComando não é mais necessário aqui, a lógica será interna

const criarProcessadorComandos = (dependencias) => {
  const { registrador, servicoMensagem, registroComandos } = dependencias; // clienteWhatsApp não parece ser usado diretamente aqui

  // --- Funções Auxiliares para o Trilho ---

  // 1. Validar Input Essencial
  const validarInput = async (dados) => {
    if (!dados.comandoNormalizado) {
      return Resultado.falha(new Error("Erro interno: comandoNormalizado ausente nos dados"));
    }
    return Resultado.sucesso(dados);
  };

  // 2. Extrair Argumentos
  const extrairArgumentos = async (dados) => {
    const { mensagem } = dados;
    try {
      const textoOriginalTrimmed = mensagem.body.trim();
      const palavras = textoOriginalTrimmed.split(' ');
      const args = palavras.slice(1);
      registrador.debug(`Processando comando: ${dados.comandoNormalizado}, Argumentos: ${args.join(' ')}`);
      return Resultado.sucesso({ ...dados, args }); // Adiciona args aos dados
    } catch (erro) {
      // Pouco provável, mas seguro envolver
      return Resultado.falha(new Error(`Erro ao extrair argumentos: ${erro.message}`));
    }
  };

  // 3. Verificar Inicialização do Sistema de Comandos
  const verificarInicializacaoComandos = async (dados) => {
    if (!registroComandos || typeof registroComandos.executarComando !== 'function') {
      // Não enviar resposta aqui, deixar para o final
      return Resultado.falha(new Error("Sistema de comandos não inicializado corretamente"));
    }
    return Resultado.sucesso(dados);
  };

  // 4. Verificar Permissão do Usuário
  const verificarPermissaoUsuario = async (dados) => {
    const { mensagem } = dados;
    try {
      const chat = await mensagem.getChat(); // Potencial ponto de falha (API externa)
      const ehGrupo = chat.id && chat.id.server === 'g.us';

      if (!ehGrupo) {
        return Resultado.sucesso(dados); // Permitido em chat privado
      }

      // Lógica de verificação de admin em grupo
      const remetenteId = mensagem.author || mensagem.from;
      if (!remetenteId) {
         return Resultado.falha(new Error("Não foi possível identificar o remetente da mensagem para verificar permissão."));
      }

      if (chat.groupMetadata && chat.groupMetadata.participants) {
        const participante = chat.groupMetadata.participants.find(p => p.id._serialized === remetenteId);
        if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
          return Resultado.sucesso(dados); // É admin, permitido
        } else {
          return Resultado.falha(new Error("Usuário não é administrador do grupo"));
        }
      } else {
        registrador.warn(`Não foi possível obter metadados ou participantes do grupo ${dados.chatId} para verificar permissões.`);
        return Resultado.falha(new Error("Não foi possível verificar permissões de administrador no grupo"));
      }
    } catch (erro) {
      return Resultado.falha(new Error(`Erro ao verificar permissões: ${erro.message}`));
    }
  };
  // Envolver com Operacoes.tentar para segurança extra com a chamada externa getChat
  const verificarPermissaoUsuarioSeguro = Operacoes.tentar(verificarPermissaoUsuario);


  // 5. Executar o Comando
  const executarComandoFinal = async (dadosOuResultadoAninhado) => {
    // Verifica se recebemos um resultado aninhado devido a Operacoes.tentar + Trilho.dePromise
    const dados = (dadosOuResultadoAninhado && dadosOuResultadoAninhado.sucesso === true && typeof dadosOuResultadoAninhado.dados !== 'undefined')
                  ? dadosOuResultadoAninhado.dados // Desembrulha se estiver aninhado
                  : dadosOuResultadoAninhado; // Assume que são os dados simples caso contrário

    // Adiciona validação robusta dos dados após o possível desembrulhamento
    if (!dados || typeof dados !== 'object') {
        registrador.error("Erro interno: dados inválidos na etapa de execução final.", { input: dadosOuResultadoAninhado });
        return Resultado.falha(new Error("Erro interno: dados inválidos na etapa de execução final."));
    }

    const { comandoNormalizado, mensagem, args, chatId } = dados;

    // Validação adicional das propriedades extraídas antes de chamar o comando
    if (typeof comandoNormalizado !== 'string' || !mensagem || !Array.isArray(args) || !chatId) {
         registrador.error("Erro interno: Dados incompletos para executarComandoFinal", { comandoNormalizado, mensagem, args, chatId });
         return Resultado.falha(new Error("Erro interno: dados incompletos para execução do comando."));
     }

    // A função executarComando já deve retornar um Resultado ou ser envolvida por Operacoes.tentar se puder lançar exceções
    // Assumindo que registroComandos.executarComando pode lançar exceções ou retornar Promise padrão
    const executarTentativa = Operacoes.tentar(registroComandos.executarComando);
    return executarTentativa(comandoNormalizado, mensagem, args, chatId);
  };

  // --- Construção do Pipeline ---
  const pipelineProcessamentoComando = Trilho.encadear(
    validarInput,
    extrairArgumentos,
    verificarInicializacaoComandos,
    verificarPermissaoUsuarioSeguro, // Usar a versão segura
    executarComandoFinal
  );

  // --- Função Principal Refatorada ---
  const processarComando = async (dadosIniciais) => {
    const resultadoFinal = await pipelineProcessamentoComando(dadosIniciais);

    // Lidar com o resultado final (Logging e Resposta ao Usuário)
    return Resultado.dobrar(
      resultadoFinal,
      (resultadoSucesso) => {
        // Comando executado com sucesso (a própria função do comando pode ter enviado respostas)
        registrador.debug(`Comando ${dadosIniciais.comandoNormalizado} processado com sucesso.`);
        // Retorna o resultado interno do comando, se houver (pode ser Resultado.sucesso(true) ou dados específicos)
        return resultadoSucesso;
      },
      async (erroFalha) => {
        // Falha em alguma etapa do pipeline
        registrador.error(`Falha ao processar comando ${dadosIniciais.comandoNormalizado}: ${erroFalha.message}`, { causa: erroFalha.causaOriginal, chatId: dadosIniciais.chatId });

        // Tentar enviar mensagem de erro amigável baseada no tipo de erro
        let mensagemErroUsuario = 'Eita! Encontrei um probleminha ao processar seu comando. Pode tentar de novo?';
        if (erroFalha.message.includes("não inicializado corretamente")) {
          mensagemErroUsuario = 'Ops! Nosso sistema de comandos está tirando uma sonequinha agora. Tente novamente daqui a pouquinho! 😴';
        } else if (erroFalha.message.includes("não é administrador")) {
          mensagemErroUsuario = 'Desculpe, apenas administradores do grupo podem executar comandos.';
        } else if (erroFalha.message.includes("comandoNormalizado ausente")) {
           // Não enviar msg para erro interno, apenas log
           return Resultado.falha(erroFalha); // Retorna a falha original
        }
        
        try {
          await servicoMensagem.enviarResposta(dadosIniciais.mensagem, mensagemErroUsuario);
        } catch (erroEnvio) {
          registrador.error(`Não foi possível enviar mensagem de erro de fallback para ${dadosIniciais.chatId}: ${erroEnvio.message}`);
        }

        return Resultado.falha(erroFalha); // Retorna a falha original do pipeline
      }
    );
  };

  return { processarComando };
};

module.exports = criarProcessadorComandos;