/**
 * ProcessadorComandos - Processamento de mensagens de comando
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const { verificarPermissaoComando } = require('../dominio/OperacoesChat');

const criarProcessadorComandos = (dependencias) => {
  const { registrador, servicoMensagem, clienteWhatsApp, registroComandos } = dependencias;

  const processarComando = async (dados) => {
    // Obter comandoNormalizado dos dados, que foi adicionado por verificarTipoMensagem
    const { mensagem, chatId, comandoNormalizado } = dados;
  
    try {
      // Verificar se comandoNormalizado foi passado (deve ter sido, se tipo é 'comando')
      if (!comandoNormalizado) {
        registrador.error(`ProcessadorComandos chamado sem comandoNormalizado nos dados! Dados: ${JSON.stringify(dados)}`);
        return Resultado.falha(new Error("Erro interno: comandoNormalizado ausente"));
      }

      // Extrair argumentos do corpo original da mensagem (Lógica Corrigida)
      // 1. Remove espaços extras no início/fim
      const textoOriginalTrimmed = mensagem.body.trim();
      // 2. Divide em palavras
      const palavras = textoOriginalTrimmed.split(' ');
      // 3. Remove a primeira palavra (que corresponde ao comando)
      //    slice(1) cria um novo array a partir do segundo elemento.
      const args = palavras.slice(1);

      registrador.debug(`Processando comando normalizado: ${comandoNormalizado}, Argumentos: ${args.join(' ')}`);
  
      // Verificação crítica para registroComandos
      if (!registroComandos || typeof registroComandos.executarComando !== 'function') {
        registrador.error("Sistema de comandos não inicializado corretamente!");
        
        // Mensagem amigável para o usuário
        await servicoMensagem.enviarResposta(
          mensagem,
          'Ops! Nosso sistema de comandos está tirando uma sonequinha agora. Tente novamente daqui a pouquinho! 😴'
        );
        
        return Resultado.falha(new Error("registroComandos não inicializado"));
      }
  
      // Verificar permissões de forma direta
      const chat = await mensagem.getChat();
      
      // Por padrão, permitir em chats privados
      let temPermissao = true;
      
      // Se for grupo, verificar se é admin
      const ehGrupo = chat.id && chat.id.server === 'g.us';
      if (ehGrupo) {
        const remetenteId = mensagem.author || mensagem.from;
        
        if (chat.groupMetadata && chat.groupMetadata.participants) {
          const participante = chat.groupMetadata.participants.find(p => 
            p.id._serialized === remetenteId
          );
          
          if (participante) {
            temPermissao = participante.isAdmin || participante.isSuperAdmin;
          } else {
            temPermissao = false;
          }
        }
      }
      
      // Se não tiver permissão, enviar mensagem e retornar erro
      if (!temPermissao) {
        await servicoMensagem.enviarResposta(
          mensagem,
          'Desculpe, apenas administradores do grupo podem executar comandos.'
        );
        return Resultado.falha(new Error("Usuário sem permissão para executar comandos"));
      }
      
      // A verificação de existência do comando já foi feita em verificarTipoMensagem
      // Podemos remover a verificação redundante aqui.
      
      // Executar comando
      return await registroComandos.executarComando(comandoNormalizado, mensagem, args, chatId);
      
    } catch (erro) {
      registrador.error(`Erro ao processar comando: ${erro.message}`);
      
      try {
        await servicoMensagem.enviarResposta(
          mensagem,
          'Eita! Encontrei um probleminha ao processar seu comando. Pode tentar de novo?'
        );
      } catch (erroEnvio) {
        registrador.error(`Não foi possível enviar mensagem de erro: ${erroEnvio.message}`);
      }
      
      return Resultado.falha(erro);
    }
  };

  return { processarComando };
};

module.exports = criarProcessadorComandos;