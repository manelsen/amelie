/**
 * ComandoUsers - Implementação do comando users
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');
const { obterOuCriarUsuario } = require('../../dominio/OperacoesChat');

const criarComandoUsers = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem, clienteWhatsApp } = dependencias;
  
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Obter o chat
      () => Trilho.dePromise(mensagem.getChat()),
      
      // Verificar se é grupo
      chat => {
        if (!chat.isGroup) {
          return Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem, 
            'Este comando só funciona em grupos.'
          ))
          .then(() => Resultado.falha(new Error("Não é um grupo")));
        }
        
        return Resultado.sucesso(chat);
      },
      
      // Obter ou criar grupo
      chat => Trilho.dePromise(gerenciadorConfig.obterOuCriarGrupo(chat))
        .then(grupo => ({ grupo, chat })),
      
      // Obter participantes e mapear para usuários
      dados => {
        const { grupo, chat } = dados;
        
        return Trilho.dePromise(
          Promise.all(
            chat.participants.map(async p => {
              const usuarioResultado = await obterOuCriarUsuario(
                gerenciadorConfig, 
                clienteWhatsApp, 
                registrador
              )(p.id._serialized, chat);
              
              return `${usuarioResultado.dados.name} (${p.id.user})`;
            })
          )
        )
        .then(listaUsuarios => ({ grupo, listaUsuarios }));
      },
      
      // Enviar resposta
      dados => {
        const { grupo, listaUsuarios } = dados;
        
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `Usuários no grupo "${grupo.title}":\n${listaUsuarios.join('\n')}`
        ));
      }
    )()
    .catch(erro => {
      if (erro.message !== "Não é um grupo") {
        registrador.error(`Erro ao listar usuários do grupo: ${erro.message}`);
      }
      return Resultado.falha(erro);
    });
  };
  
  return criarComando(
    'users', 
    'Lista usuários no grupo atual', 
    executar
  );
};

module.exports = criarComandoUsers;