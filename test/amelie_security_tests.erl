-module(amelie_security_tests).
-include_lib("eunit/include/eunit.hrl").
-include_lib("kernel/include/file.hrl").
-export([with_env/3]).

media_paths_test() ->
    with_temp(fun(Dir) ->
        Previous = os:getenv("MEDIA_TEMP_DIR"),
        Root = filename:join(Dir, "spool"),
        ok = file:make_dir(Root),
        ok = file:change_mode(Root, 8#700),
        true = os:putenv("MEDIA_TEMP_DIR", Root),
        try
            Outside = filename:join(Dir, "private.txt"),
            ok = file:write_file(Outside, <<"private">>),
            ?assertMatch({error, _}, amelie_ffi:read_bridge_media(list_to_binary(Outside))),
            ?assertMatch({error, _}, amelie_ffi:validate_bridge_media(list_to_binary(Root ++ "/../private.txt"))),
            Symlink = filename:join(Root, "amelie_midia_link"),
            ok = file:make_symlink(Outside, Symlink),
            ?assertMatch({error, _}, amelie_ffi:read_bridge_media(list_to_binary(Symlink))),
            Hardlink = filename:join(Root, "amelie_midia_hardlink"),
            ok = file:make_link(Outside, Hardlink),
            ?assertMatch({error, _}, amelie_ffi:read_bridge_media(list_to_binary(Hardlink))),
            ?assertEqual({ok, <<"private">>}, file:read_file(Outside)),
            Valid = filename:join(Root, "amelie_midia_audio_123.ogg"),
            ok = file:write_file(Valid, <<"audio">>),
            ?assertEqual({ok, <<"audio">>}, amelie_ffi:read_bridge_media(list_to_binary(Valid))),
            ?assertEqual({error, enoent}, file:read_file(Valid)),
            RootLink = filename:join(Dir, "rootlink"),
            ok = file:make_symlink(Root, RootLink),
            true = os:putenv("MEDIA_TEMP_DIR", RootLink),
            ?assertMatch({error, _}, amelie_ffi:validate_bridge_media(list_to_binary(RootLink ++ "/amelie_midia_link")))
        after restore_env("MEDIA_TEMP_DIR", Previous)
        end
    end).

ffprobe_does_not_execute_shell_test() ->
    with_temp(fun(Dir) ->
        Previous = os:getenv("PATH"),
        Exe = filename:join(Dir, "ffprobe"),
        Marker = filename:join(Dir, "injected"),
        %% Fake executable confirms that the supplied path is one literal argument.
        ok = file:write_file(Exe, <<"#!/bin/sh\nprintf 'audio\\n'\n">>),
        ok = file:change_mode(Exe, 8#700),
        true = os:putenv("PATH", Dir),
        try
            Path = iolist_to_binary(["fake$(printf hacked>", Marker, ").mp4"]),
            ?assertEqual(true, amelie_ffi:video_tem_audio(Path)),
            ?assertEqual({error, enoent}, file:read_file(Marker))
        after restore_env("PATH", Previous)
        end
    end).

private_media_has_unique_names_and_permissions_test() ->
    with_temp(fun(Dir) ->
        with_env(<<"MEDIA_TEMP_DIR">>, list_to_binary(Dir ++ "/spool"), fun() ->
            {ok, A} = amelie_ffi:write_private_media(<<"conversation A">>),
            {ok, B} = amelie_ffi:write_private_media(<<"conversation B">>),
            ?assertNotEqual(A, B),
            ?assertEqual({ok, <<"conversation A">>}, file:read_file(A)),
            ?assertEqual({ok, <<"conversation B">>}, file:read_file(B)),
            {ok, Info} = file:read_file_info(A),
            ?assertEqual(8#600, Info#file_info.mode band 8#777)
        end)
    end).

constant_time_comparison_test() ->
    ?assert(amelie_ffi:constant_time_equal(<<"abc">>, <<"abc">>)),
    ?assertNot(amelie_ffi:constant_time_equal(<<"abc">>, <<"abd">>)).

safe_mime_test() ->
    ?assertEqual(<<"image/jpeg">>, amelie_ffi:safe_mime(<<"image/jpeg">>)),
    ?assertEqual(<<"audio/ogg">>, amelie_ffi:safe_mime(<<"audio/ogg; codecs=opus">>)),
    ?assertEqual(<<"video/mp4">>, amelie_ffi:safe_mime(<<"Video/MP4">>)),
    %% Injeção no multipart: CRLF e aspas não passam.
    ?assertEqual(<<"application/octet-stream">>,
                 amelie_ffi:safe_mime(<<"video/mp4\r\nX-Injetado: 1">>)),
    ?assertEqual(<<"application/octet-stream">>,
                 amelie_ffi:safe_mime(<<"video/mp4\"}},\"x\":{\"y\":\"">>)),
    ?assertEqual(<<"application/octet-stream">>, amelie_ffi:safe_mime(<<"semtipo">>)),
    ?assertEqual(<<"application/octet-stream">>, amelie_ffi:safe_mime(not_binary)).

with_temp(F) ->
    Dir = "/tmp/amelie-security-" ++ integer_to_list(erlang:unique_integer([positive])),
    ok = file:make_dir(Dir),
    try F(Dir) after file:del_dir_r(Dir) end.

restore_env(Name, false) -> os:unsetenv(Name);
restore_env(Name, Value) -> os:putenv(Name, Value).

with_env(Name, Value, F) ->
    Key = binary_to_list(Name),
    Previous = os:getenv(Key),
    true = os:putenv(Key, binary_to_list(Value)),
    try F() after restore_env(Key, Previous) end.
