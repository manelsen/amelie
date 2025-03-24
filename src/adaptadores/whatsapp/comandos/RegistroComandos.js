/**
 * RegistroComandos - Registro central de todos os comandos disponíveis
 */
const _ = require('lodash/fp');
const { Resultado } = require('../../../utilitarios/Ferrovia');

// Imports de todos os comandos
const criarComandoReset = require('./implementacoes/ComandoReset');
const criarComandoAjuda = require('./implementacoes/ComandoAjuda');
const criarComandoPrompt = require('./implementacoes/ComandoPrompt');
const criarComandoConfig = require('./implementacoes/ComandoConfig');
const criarComandoUsers = require('./implementacoes/ComandoUsers');
const criarComandoCego = require('./implementacoes/ComandoCego');
const criarComandoAudio = require('./implementacoes/ComandoAudio');
const criarComandoVideo = require('./implementacoes/ComandoVideo');
const criarComandoImagem = require('./implementacoes/ComandoImagem');
const criarComandoLongo = require('./implementacoes/ComandoLongo');
const criarComandoCurto = require('./implementacoes/ComandoCurto');
const criarComandoLegenda = require('./implementacoes/ComandoLegenda');
const criarComandoFilas = require('./implementacoes/ComandoFilas');

const criarRegistroComandos = (dependencias) => {
  // Instanciar todos os comandos
  const comandos = [
    criarComandoReset(dependencias),
    criarComandoAjuda(dependencias),
    criarComandoPrompt(dependencias),
    criarComandoConfig(dependencias),
    criarComandoUsers(dependencias),
    criarComandoCego(dependencias),
    criarComandoAudio(dependencias),
    criarComandoVideo(dependencias),
    criarComandoImagem(dependencias),
    criarComandoLongo(dependencias),
    criarComandoCurto(dependencias),
    criarComandoLegenda(dependencias),
    criarComandoFilas(dependencias)
  ];
  
  // Encontrar comando por nome
  const encontrarComando = nomeComando => 
    comandos.find(comando => comando.corresponde(nomeComando));
   
  // Executar comando pelo nome
  const executarComando = (nomeComando, mensagem, args, chatId) => {
    const comando = encontrarComando(nomeComando);
    
    if (!comando) {
      return Resultado.falha(new Error(`Comando desconhecido: ${nomeComando}`));
    }
    
    return comando.executar(mensagem, args, chatId);
  };

  const comandoExiste = (nomeComando) => {
    return Boolean(comandos[nomeComando]);
  };
  
  // Obter lista de comandos para ajuda
  const listarComandos = () => 
    comandos.map(comando => ({
      nome: comando.nome,
      descricao: comando.descricao
    }));
  
  return {
    encontrarComando,
    executarComando,
    listarComandos,
    comandoExiste,
    comandos
  };

  
};


module.exports = criarRegistroComandos;