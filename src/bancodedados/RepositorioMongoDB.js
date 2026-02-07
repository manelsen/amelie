// src/bancodedados/RepositorioMongoDB.js
/**
 * RepositorioMongoDB - Implementação funcional de Repositorio para MongoDB
 */
const { MongoClient } = require('mongodb');
const { criarRepositorio, Resultado } = require('./Repositorio');

const criarRepositorioMongoDB = (stringConexao, nomeBanco, nomeColecao, registrador) => {
  let cliente = null;
  let colecao = null;

  const garantirConexao = async () => {
    if (colecao) return Resultado.sucesso(colecao);

    try {
      cliente = await MongoClient.connect(stringConexao);
      colecao = cliente.db(nomeBanco).collection(nomeColecao);
      registrador.info(`Conectado ao MongoDB: ${nomeColecao}`);
      return Resultado.sucesso(colecao);
    } catch (erro) {
      registrador.error(`Erro ao conectar MongoDB: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };

  const base = criarRepositorio();

  return {
    ...base,

    encontrarUm: async (consulta) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        const documento = await colecao.findOne(consulta);
        return Resultado.sucesso(documento ? { ...documento } : null);
      } catch (erro) {
        registrador.error(`Erro ao buscar documento: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    encontrar: async (consulta, opcoes = {}) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        let cursor = colecao.find(consulta);
        if (opcoes.ordenar) cursor = cursor.sort(opcoes.ordenar);
        if (opcoes.pular) cursor = cursor.skip(opcoes.pular);
        if (opcoes.limite) cursor = cursor.limit(opcoes.limite);
        
        const documentos = await cursor.toArray();
        const documentosImutaveis = documentos.map(doc => ({ ...doc }));
        return Resultado.sucesso(documentosImutaveis);
      } catch (erro) {
        registrador.error(`Erro ao buscar documentos: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    inserir: async (documento) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      const copiaDocumento = { ...documento };
      try {
        const resultado = await colecao.insertOne(copiaDocumento);
        return Resultado.sucesso({ ...copiaDocumento, _id: resultado.insertedId });
      } catch (erro) {
        registrador.error(`Erro ao inserir documento: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    atualizar: async (consulta, atualizacao, opcoes = {}) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        const resultado = await colecao.updateMany(consulta, atualizacao, opcoes);
        return Resultado.sucesso({
          numAfetados: resultado.modifiedCount,
          documentosAfetados: resultado.upsertedId ? { _id: resultado.upsertedId } : null,
          upsert: !!resultado.upsertedId
        });
      } catch (erro) {
        registrador.error(`Erro ao atualizar documentos: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    remover: async (consulta, opcoes = {}) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        const resultado = await colecao.deleteMany(consulta);
        return Resultado.sucesso(resultado.deletedCount);
      } catch (erro) {
        registrador.error(`Erro ao remover documentos: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    contar: async (consulta) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        const contagem = await colecao.countDocuments(consulta);
        return Resultado.sucesso(contagem);
      } catch (erro) {
        registrador.error(`Erro ao contar documentos: ${erro.message}`);
        return Resultado.falha(erro);
      }
    },

    garantirIndice: async (nomeCampo, opcoes = {}) => {
      const resConexao = await garantirConexao();
      if (!resConexao.sucesso) return resConexao;
      
      try {
        await colecao.createIndex({ [nomeCampo]: 1 }, opcoes);
        return Resultado.sucesso(true);
      } catch (erro) {
        registrador.error(`Erro ao criar índice: ${erro.message}`);
        return Resultado.falha(erro);
      }
    }
  };
};

module.exports = { criarRepositorioMongoDB };
