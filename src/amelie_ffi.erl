-module(amelie_ffi).
-include_lib("kernel/include/file.hrl").
-export([read_file/1, get_env/1, now_ms/0,
         sha256_hex/1, memoria_total_mb/0, memoria_processos_mb/0,
         contagem_processos/0, upload_file/3, upload_bytes/3,
         strip_timestamps/1, video_tem_audio/1,
         constant_time_equal/2, validate_bridge_media/1, read_bridge_media/1,
         cache_key/3, write_private_media/1, limpar_midias_antigas/1,
         delete_file/1, ensure_applications_started/0, safe_mime/1,
         reservar_vaga/2, liberar_vaga/1, criar_e_monitorar/1,
         criar_ligado_e_monitorar/1]).

%% Lê arquivo do disco.
%% Retorna {ok, Binary} | {error, Binary} — Result(BitArray, String) no Gleam.
read_file(Path) ->
    case file:read_file(Path) of
        {ok, Bin} -> {ok, Bin};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

%% Retorna timestamp atual em milissegundos.
now_ms() ->
    erlang:system_time(millisecond).

%% SHA-256 do dado como string hexadecimal minúscula.
sha256_hex(Data) ->
    Hash = crypto:hash(sha256, Data),
    string:lowercase(binary:encode_hex(Hash)).

%% Serialização estrutural inclui TODOS os argumentos que chegam ao provedor.
cache_key(Prompt, History, Model) ->
    sha256_hex(term_to_binary({cache_v2, Prompt, History, Model})).

constant_time_equal(A, B) ->
    crypto:hash_equals(crypto:hash(sha256, A), crypto:hash(sha256, B)).

%% Nunca aceita caminhos arbitrários do payload nem links no spool privado.
validate_bridge_media(Path) when is_binary(Path) ->
    Root = media_root(),
    Name = binary_to_list(Path),
    Base = filename:basename(Name),
    ValidName = re:run(Base, "^amelie_midia_[a-zA-Z0-9_.-]+$", [{capture, none}]) =:= match,
    case filename:pathtype(Root) =:= absolute andalso
         filename:dirname(Name) =:= Root andalso
         filename:join(Root, Base) =:= Name andalso ValidName of
        false -> {error, <<"caminho de mídia não permitido"/utf8>>};
        true ->
            case {file:read_link_info(Root), file:read_link_info(Name)} of
                {{ok, #file_info{type = directory, mode = Mode}},
                 {ok, #file_info{type = regular, links = 1, size = Size}}}
                    when Mode band 8#777 =:= 8#700, Size =< 50 * 1024 * 1024 ->
                    {ok, Path};
                _ -> {error, <<"arquivo de mídia não permitido"/utf8>>}
            end
    end.

media_root() ->
    case os:getenv("MEDIA_TEMP_DIR") of
        false -> "/tmp/amelie-media";
        "" -> "/tmp/amelie-media";
        Value -> Value
    end.

%% Arquivos internos nunca incorporam IDs externos nem timestamps previsíveis.
write_private_media(Data) when byte_size(Data) =< 50 * 1024 * 1024 ->
    Root = media_root(),
    case filename:pathtype(Root) of
        absolute ->
            case file:make_dir(Root) of
                ok -> _ = file:change_mode(Root, 8#700);
                _ -> ok
            end,
            case file:read_link_info(Root) of
                {ok, #file_info{type = directory, mode = Mode}} when Mode band 8#777 =:= 8#700 ->
                    Name = "amelie_local_" ++ binary_to_list(binary:encode_hex(crypto:strong_rand_bytes(16))),
                    Path = filename:join(Root, Name),
                    case file:open(Path, [write, binary, exclusive, raw]) of
                        {ok, File} ->
                            Result = case file:change_mode(Path, 8#600) of
                                ok -> file:write(File, Data);
                                Error -> Error
                            end,
                            Closed = file:close(File),
                            case {Result, Closed} of
                                {ok, ok} -> {ok, list_to_binary(Path)};
                                _ -> _ = file:delete(Path), {error, <<"falha ao gravar mídia temporária"/utf8>>}
                            end;
                        _ -> {error, <<"falha ao criar mídia temporária"/utf8>>}
                    end;
                _ -> {error, <<"diretório de mídia não é privado"/utf8>>}
            end;
        _ -> {error, <<"diretório de mídia deve ser absoluto"/utf8>>}
    end;
write_private_media(_) -> {error, <<"mídia excede 50 MiB"/utf8>>}.

%% O diretório 0700 é escrito apenas pelo bridge, com nomes aleatórios.
%% Revalida no momento da leitura e só remove após uma leitura bem-sucedida.
read_bridge_media(Path) ->
    case validate_bridge_media(Path) of
        {ok, Path} ->
            case read_file(Path) of
                {ok, Data} ->
                    _ = file:delete(Path),
                    {ok, Data};
                Error -> Error
            end;
        Error -> Error
    end.

%% Remove arquivo do disco. Retorna {ok, nil} | {error, Reason}.
delete_file(Path) when is_binary(Path) ->
    case file:delete(Path) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end;
delete_file(Path) when is_list(Path) ->
    case file:delete(Path) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end;
delete_file(_) ->
    {error, <<"caminho inválido"/utf8>>}.

%% Varre o diretório de mídias temporárias e remove arquivos órfãos (amelie_midia_*
%% ou amelie_local_*) cuja idade em segundos seja maior ou igual a MaxAgeSeconds.
%% Retorna {ok, QuantidadeRemovida} | {error, Reason}.
limpar_midias_antigas(MaxAgeSeconds) when is_integer(MaxAgeSeconds), MaxAgeSeconds >= 0 ->
    Root = media_root(),
    case file:list_dir(Root) of
        {ok, Filenames} ->
            NowSecs = calendar:datetime_to_gregorian_seconds(erlang:universaltime()),
            Deleted = lists:foldl(
                fun(Name, Count) ->
                    case is_media_temp_file(Name) of
                        true ->
                            FullPath = filename:join(Root, Name),
                            case file:read_link_info(FullPath, [{time, universal}]) of
                                {ok, #file_info{type = regular, mtime = Mtime}} ->
                                    FileSecs = calendar:datetime_to_gregorian_seconds(Mtime),
                                    Age = NowSecs - FileSecs,
                                    case Age >= MaxAgeSeconds of
                                        true ->
                                            case file:delete(FullPath) of
                                                ok -> Count + 1;
                                                _ -> Count
                                            end;
                                        false -> Count
                                    end;
                                _ -> Count
                            end;
                        false -> Count
                    end
                end,
                0,
                Filenames
            ),
            {ok, Deleted};
        {error, enoent} ->
            {ok, 0};
        {error, Reason} ->
            {error, atom_to_binary(Reason, utf8)}
    end;
limpar_midias_antigas(_) ->
    {error, <<"idade máxima inválida"/utf8>>}.

is_media_temp_file(Name) ->
    (lists:prefix("amelie_midia_", Name) orelse lists:prefix("amelie_local_", Name))
    andalso filename:basename(Name) =:= Name.

%% Métricas de memória e processos BEAM.
memoria_total_mb() ->
    erlang:memory(total) div (1024 * 1024).

memoria_processos_mb() ->
    erlang:memory(processes) div (1024 * 1024).

contagem_processos() ->
    erlang:system_info(process_count).

%% Garante que aplicações de rede (inets, ssl) estejam iniciadas no nó BEAM.
ensure_applications_started() ->
    _ = inets:start(),
    _ = ssl:start(),
    ok.

%% Faz upload multipart de arquivo para a Gemini File API.
%% Retorna {ok, ResponseBody} | {error, Reason}.
upload_file(ApiKey, FilePath, RawMimeType) ->
    case file:read_file(FilePath) of
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)};
        {ok, FileData} -> upload_bytes(ApiKey, FileData, RawMimeType)
    end.

%% Envia dados já em memória à File API do Gemini, sem passar pelo disco.
upload_bytes(ApiKey, FileData, RawMimeType) ->
    %% O MIME vem do remetente (WhatsApp ou Telegram) e é concatenado no JSON
    %% e no cabeçalho do multipart: só passa se for tipo/subtipo simples.
    MimeType = safe_mime(RawMimeType),
    Boundary = "gc0p4Jq0M2Yt08jU534c0p",
    BoundaryBin = list_to_binary(Boundary),
    MetaJson = iolist_to_binary([
        <<"{\"file\":{\"mimeType\":\"">>, MimeType, <<"\"}}">>
    ]),
    Body = iolist_to_binary([
        <<"--">>, BoundaryBin, <<"\r\n">>,
        <<"Content-Type: application/json; charset=utf-8\r\n\r\n">>,
        MetaJson, <<"\r\n">>,
        <<"--">>, BoundaryBin, <<"\r\n">>,
        <<"Content-Type: ">>, MimeType, <<"\r\n\r\n">>,
        FileData, <<"\r\n">>,
        <<"--">>, BoundaryBin, <<"--\r\n">>
    ]),
    %% A chave vai no cabeçalho, nunca na URL: URL aparece em logs e erros.
    URL = "https://generativelanguage.googleapis.com/upload/v1beta/files",
    Headers = [{"x-goog-upload-protocol", "multipart"},
               {"x-goog-api-key", binary_to_list(ApiKey)}],
    ContentType = "multipart/related; boundary=" ++ Boundary,
    Opts = [{timeout, 120000}, {connect_timeout, 10000},
            {autoredirect, false},
            {ssl, [{verify, verify_peer}, {cacerts, public_key:cacerts_get()},
                   {server_name_indication, "generativelanguage.googleapis.com"},
                   {customize_hostname_check, [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}]}],
    case httpc:request(post, {URL, Headers, ContentType, Body}, Opts, []) of
        {ok, {{_, 200, _}, _, RespBody}} ->
            {ok, list_to_binary(RespBody)};
        {ok, {{_, Status, _}, _, RespBody}} ->
            Msg = iolist_to_binary([
                <<"upload status ">>, integer_to_list(Status),
                <<": ">>, list_to_binary(RespBody)
            ]),
            {error, Msg};
        {error, Reason} ->
            Msg = list_to_binary(io_lib:format("~p", [Reason])),
            {error, Msg}
    end.

%% Normaliza (sem parâmetros, minúsculas) e aceita só MIME no formato
%% tipo/subtipo com caracteres de token. Qualquer outra coisa vira
%% application/octet-stream. Mesma regra de sanitizeMime na ponte Go.
safe_mime(Raw) when is_binary(Raw) ->
    [Base | _] = binary:split(Raw, <<";">>),
    Mime = string:lowercase(string:trim(Base)),
    case byte_size(Mime) =< 127 andalso
         re:run(Mime, <<"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$">>,
                [{capture, none}]) =:= match of
        true -> Mime;
        false -> <<"application/octet-stream">>
    end;
safe_mime(_) ->
    <<"application/octet-stream">>.

%% Lê variável de ambiente.
%% Retorna {ok, Binary} | {error, nil} — Result(String, Nil) no Gleam.
get_env(Name) ->
    case os:getenv(binary_to_list(Name)) of
        false -> {error, nil};
        Value -> {ok, list_to_binary(Value)}
    end.

%% Remove timestamps MM:SS ou HH:MM:SS (com espaço opcional ao redor).
strip_timestamps(Text) ->
    {ok, Re} = re:compile(<<"\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*">>),
    re:replace(Text, Re, <<" ">>, [global, {return, binary}]).

%% Verifica se o arquivo de vídeo possui faixa/stream de áudio.
%% Executa em processo efêmero dedicado para nunca poluir a mailbox
%% de atores OTP chamadores (ex: fila_midia) com mensagens do port.
%% Retorna true | false.
video_tem_audio(Path) ->
    case os:find_executable("ffprobe") of
        false ->
            true;
        Ffprobe ->
            Parent = self(),
            Ref = make_ref(),
            spawn(fun() ->
                Result = try
                    Port = open_port({spawn_executable, Ffprobe}, [
                        {args, ["-v", "error", "-protocol_whitelist", "file",
                                "-select_streams", "a:0", "-show_entries", "stream=codec_type",
                                "-of", "default=nw=1:nk=1", "-i", binary_to_list(Path)]},
                        binary, exit_status, use_stdio, stderr_to_stdout
                    ]),
                    ffprobe_wait(Port, <<>>, erlang:monotonic_time(millisecond) + 10000)
                catch
                    error:_ -> false
                end,
                Parent ! {Ref, Result}
            end),
            receive
                {Ref, HasAudio} -> HasAudio
            after 11000 ->
                false
            end
    end.

ffprobe_wait(Port, Acc, Deadline) ->
    Remaining = max(0, Deadline - erlang:monotonic_time(millisecond)),
    receive
        {Port, {data, Data}} when byte_size(Acc) + byte_size(Data) =< 4096 ->
            ffprobe_wait(Port, <<Acc/binary, Data/binary>>, Deadline);
        {Port, {data, _}} ->
            catch port_close(Port),
            false;
        {Port, {exit_status, 0}} -> string:trim(Acc) =:= <<"audio">>;
        {Port, {exit_status, _}} -> false
    after Remaining ->
        catch port_close(Port),
        false
    end.


%% Contador global de vagas, sem dono: um atomics guardado em persistent_term
%% por nome. Reserva só se couber em Max; liberar devolve a vaga.
vagas_ref(Nome) ->
    Chave = {amelie_vagas, Nome},
    case persistent_term:get(Chave, undefined) of
        undefined ->
            %% Criação sob lock: duas primeiras reservas simultâneas não
            %% podem publicar contadores diferentes para o mesmo nome.
            global:trans({Chave, self()}, fun() ->
                case persistent_term:get(Chave, undefined) of
                    undefined ->
                        Ref = atomics:new(1, []),
                        persistent_term:put(Chave, Ref),
                        Ref;
                    Ref -> Ref
                end
            end, [node()]);
        Ref -> Ref
    end.

%% Compara e troca: só incrementa se ainda couber, para uma tentativa sem
%% vaga não ocupar uma vaga por um instante e recusar outra que caberia.
reservar_vaga(Nome, Max) ->
    reservar_vaga_cas(vagas_ref(Nome), Max).

reservar_vaga_cas(Ref, Max) ->
    Atual = atomics:get(Ref, 1),
    case Atual < Max of
        false -> false;
        true ->
            case atomics:compare_exchange(Ref, 1, Atual, Atual + 1) of
                ok -> true;
                _Outro -> reservar_vaga_cas(Ref, Max)
            end
    end.

liberar_vaga(Nome) ->
    atomics:sub(vagas_ref(Nome), 1, 1),
    nil.

%% Cria o processo já monitorado, de forma atômica. Devolve {Pid, Ref}:
%% #(Pid, Monitor) no Gleam, pois o Monitor do gleam_erlang é a referência.
criar_e_monitorar(Fun) ->
    erlang:spawn_monitor(Fun).

%% Como criar_e_monitorar, mas também ligado a quem cria.
criar_ligado_e_monitorar(Fun) ->
    erlang:spawn_opt(Fun, [link, monitor]).
