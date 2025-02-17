scriptencoding utf-8
let s:is_vim = !has('nvim')
let s:map_next = 1
let s:cmd_mapping = has('nvim') || has('patch-8.2.1978')

function! coc#snippet#_select_mappings()
  if !get(g:, 'coc_selectmode_mapping', 1)
    return
  endif

  redir => mappings
    silent! smap
  redir END

  for map in map(filter(split(mappings, '\n'),
        \ "v:val !~# '^s' && v:val !~# '^\\a*\\s*<\\S\\+>'"),
        \ "matchstr(v:val, '^\\a*\\s*\\zs\\S\\+')")
    silent! execute 'sunmap' map
    silent! execute 'sunmap <buffer>' map
  endfor

  " same behaviour of ultisnips
  snoremap <silent> <BS> <c-g>c
  snoremap <silent> <DEL> <c-g>c
  snoremap <silent> <c-h> <c-g>c
  snoremap <c-r> <c-g>"_c<c-r>
endfunction

function! coc#snippet#show_choices(lnum, col, len, values) abort
  let m = mode()
  call cursor(a:lnum, a:col + a:len)
  if m !=# 'i'
    call feedkeys("\<Esc>i")
  endif
  call timer_start(20, { -> coc#_do_complete(a:col - 1, a:values, 0)})
  redraw
endfunction

function! coc#snippet#enable(...)
  if get(b:, 'coc_snippet_active', 0) == 1
    return
  endif
  let complete = get(a:, 1, 0)
  let b:coc_snippet_active = 1
  call coc#snippet#_select_mappings()
  let nextkey = get(g:, 'coc_snippet_next', '<C-j>')
  let prevkey = get(g:, 'coc_snippet_prev', '<C-k>')
  if maparg(nextkey, 'i') =~# 'expand-jump'
    let s:map_next = 0
  endif
  if s:map_next
    execute 'inoremap <buffer><nowait><silent>'.nextkey." <C-R>=coc#snippet#jump(1, ".complete.")<cr>"
  endif
  execute 'inoremap <buffer><nowait><silent>'.prevkey." <C-R>=coc#snippet#jump(0, ".complete.")<cr>"
  execute 'snoremap <buffer><nowait><silent>'.prevkey." <Esc>:call coc#snippet#jump(0, ".complete.")<cr>"
  execute 'snoremap <buffer><nowait><silent>'.nextkey." <Esc>:call coc#snippet#jump(1, ".complete.")<cr>"
endfunction

function! coc#snippet#jump(direction, complete) abort
  if a:direction == 1 && a:complete && pumvisible()
    let pre = exists('*complete_info') && complete_info()['selected'] == -1 ? "\<C-n>" : ''
    call feedkeys(pre."\<C-y>", 'in')
    return ''
  endif
  call coc#rpc#request(a:direction == 1 ? 'snippetNext' : 'snippetPrev', [])
  return ''
endfunction

function! coc#snippet#disable()
  if get(b:, 'coc_snippet_active', 0) == 0
    return
  endif
  let b:coc_snippet_active = 0
  let nextkey = get(g:, 'coc_snippet_next', '<C-j>')
  let prevkey = get(g:, 'coc_snippet_prev', '<C-k>')
  if s:map_next
    silent! execute 'iunmap <buffer> <silent> '.nextkey
  endif
  silent! execute 'iunmap <buffer> <silent> '.prevkey
  silent! execute 'sunmap <buffer> <silent> '.prevkey
  silent! execute 'sunmap <buffer> <silent> '.nextkey
endfunction

function! coc#snippet#select(position, text) abort
  if mode() == 's'
    call feedkeys("\<Esc>", 'in')
  endif
  let cursor = coc#snippet#to_cursor(a:position)
  call cursor([cursor[0], cursor[1] - (&selection !~# 'exclusive')])
  let len = strchars(a:text) - (&selection !~# 'exclusive')
  let cmd = ''
  let cmd .= mode()[0] ==# 'i' ? "\<Esc>l" : ''
  let cmd .= printf('v%s', len > 0 ? len . 'h' : '')
  let cmd .= "o\<C-g>"
  call feedkeys(cmd, 'n')
endfunction

function! coc#snippet#move(position) abort
  if mode() == 's'
    call feedkeys("\<Esc>", 'in')
  endif
  let pos = coc#snippet#to_cursor(a:position)
  call cursor(pos)
  if pos[1] > strlen(getline(pos[0]))
    startinsert!
  else
    startinsert
  endif
endfunction


function! coc#snippet#to_cursor(position) abort
  let line = getline(a:position.line + 1)
  if line is v:null
    return [a:position.line + 1, a:position.character + 1]
  endif
  return [a:position.line + 1, byteidx(line, a:position.character) + 1]
endfunction
