'use strict'
import { Neovim } from '@chemzqm/neovim'
import { CancellationTokenSource, Disposable } from 'vscode-languageserver-protocol'
import events, { InsertChange, PopupChangeEvent } from '../events'
import Document from '../model/document'
import sources from '../sources'
import { CompleteOption, ExtendedCompleteItem, FloatConfig, ISource, VimCompleteItem } from '../types'
import { disposeAll } from '../util'
import * as Is from '../util/is'
import { equals } from '../util/object'
import { byteLength, byteSlice, isWord } from '../util/string'
import workspace from '../workspace'
import Complete, { CompleteConfig } from './complete'
import Floating, { PumBounding } from './floating'
import MruLoader from './mru'
import { shouldIndent, shouldStop, waitInsertEvent, waitTextChangedI } from './util'
const logger = require('../util/logger')('completion')
const completeItemKeys = ['abbr', 'menu', 'info', 'kind', 'icase', 'dup', 'empty', 'user_data']

export interface LastInsert {
  character: string
  timestamp: number
}

export class Completion implements Disposable {
  public config: CompleteConfig
  private nvim: Neovim
  private pretext: string | undefined
  private hasInsert = false
  private activated = false
  private triggering = false
  private triggerTimer: NodeJS.Timer
  private popupEvent: PopupChangeEvent
  private floating: Floating
  private disposables: Disposable[] = []
  private complete: Complete | null = null
  private resolveTokenSource: CancellationTokenSource
  // saved for commit character.
  private previousItem: VimCompleteItem | {} | undefined
  private mru: MruLoader

  public init(): void {
    this.nvim = workspace.nvim
    this.config = this.getCompleteConfig()
    this.mru = new MruLoader(this.config.selection)
    void this.mru.load()
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('suggest')) {
        this.config = this.getCompleteConfig()
      }
    }, null, this.disposables)
    this.floating = new Floating(workspace.nvim, workspace.env.isVim)
    events.on('InsertLeave', () => {
      this.stop()
    }, null, this.disposables)
    events.on('CursorMovedI', (bufnr, cursor) => {
      let { option } = this
      if (!option) return
      if (this.triggerTimer) clearTimeout(this.triggerTimer)
      if (bufnr !== option.bufnr
        || cursor[0] !== option.linenr
        || cursor[1] < option.colnr) {
        this.stop()
      }
    }, null, this.disposables)
    events.on('InsertEnter', this.onInsertEnter, this, this.disposables)
    events.on('TextChangedP', this.onTextChangedP, this, this.disposables)
    events.on('TextChangedI', this.onTextChangedI, this, this.disposables)
    events.on('CompleteDone', async item => {
      this.previousItem = this.popupEvent?.completed_item
      this.popupEvent = null
      this.hasInsert = false
      if (!this.activated || item.closed) return
      this.cancelResolve()
      if (item.close) return this.stop()
      if (!Is.vimCompleteItem(item)) {
        let ev = await waitInsertEvent()
        if (ev == 'CursorMovedI') this.stop()
      } else {
        await this.onCompleteDone(item)
      }
    }, null, this.disposables)
    events.on('MenuPopupChanged', async ev => {
      if (!this.activated || this.document?.isCommandLine) return
      if (equals(this.popupEvent, ev)) return
      this.cancelResolve()
      this.popupEvent = ev
      await this.onPumChange()
    }, null, this.disposables)
  }

  public get option(): CompleteOption {
    if (!this.complete) return null
    return this.complete.option
  }

  private get selectedItem(): VimCompleteItem | null {
    if (!this.popupEvent) return null
    let { completed_item } = this.popupEvent
    return Is.vimCompleteItem(completed_item) ? completed_item : null
  }

  public get isActivated(): boolean {
    return this.activated
  }

  private get document(): Document | null {
    if (!this.option) return null
    return workspace.getDocument(this.option.bufnr)
  }

  private getCompleteConfig(): CompleteConfig {
    let suggest = workspace.getConfiguration('suggest')
    function getConfig<T>(key, defaultValue: T): T {
      return suggest.get<T>(key, defaultValue)
    }
    let keepCompleteopt = getConfig<boolean>('keepCompleteopt', false)
    let autoTrigger = getConfig<string>('autoTrigger', 'always')
    if (keepCompleteopt && autoTrigger != 'none') {
      let { completeOpt } = workspace
      if (!completeOpt.includes('noinsert') && !completeOpt.includes('noselect')) {
        autoTrigger = 'none'
      }
    }
    let floatEnable = workspace.floatSupported && getConfig<boolean>('floatEnable', true)
    let acceptSuggestionOnCommitCharacter = workspace.env.pumevent && getConfig<boolean>('acceptSuggestionOnCommitCharacter', false)
    return {
      autoTrigger,
      floatEnable,
      keepCompleteopt,
      selection: getConfig<'none' | 'recentlyUsed' | 'recentlyUsedByPrefix'>('selection', 'recentlyUsed'),
      floatConfig: getConfig<FloatConfig>('floatConfig', {}),
      defaultSortMethod: getConfig<string>('defaultSortMethod', 'length'),
      removeDuplicateItems: getConfig<boolean>('removeDuplicateItems', false),
      disableMenuShortcut: getConfig<boolean>('disableMenuShortcut', false),
      acceptSuggestionOnCommitCharacter,
      disableKind: getConfig<boolean>('disableKind', false),
      disableMenu: getConfig<boolean>('disableMenu', false),
      previewIsKeyword: getConfig<string>('previewIsKeyword', '@,48-57,_192-255'),
      enablePreview: getConfig<boolean>('enablePreview', false),
      enablePreselect: getConfig<boolean>('enablePreselect', false),
      triggerCompletionWait: getConfig<number>('triggerCompletionWait', 0),
      labelMaxLength: getConfig<number>('labelMaxLength', 200),
      triggerAfterInsertEnter: getConfig<boolean>('triggerAfterInsertEnter', false),
      noselect: getConfig<boolean>('noselect', true),
      maxItemCount: getConfig<number>('maxCompleteItemCount', 50),
      timeout: getConfig<number>('timeout', 500),
      minTriggerInputLength: getConfig<number>('minTriggerInputLength', 1),
      snippetIndicator: getConfig<string>('snippetIndicator', '~'),
      fixInsertedWord: getConfig<boolean>('fixInsertedWord', true),
      localityBonus: getConfig<boolean>('localityBonus', true),
      highPrioritySourceLimit: getConfig<number>('highPrioritySourceLimit', null),
      lowPrioritySourceLimit: getConfig<number>('lowPrioritySourceLimit', null),
      ignoreRegexps: getConfig<string[]>('ignoreRegexps', []),
      asciiCharactersOnly: getConfig<boolean>('asciiCharactersOnly', false)
    }
  }

  public async startCompletion(option: CompleteOption, sourceList?: ISource[]): Promise<void> {
    try {
      let doc = workspace.getAttachedDocument(option.bufnr)
      option.filetype = doc.filetype
      logger.debug('trigger completion with', option)
      this.stop()
      this.pretext = byteSlice(option.line, 0, option.colnr - 1)
      sourceList = sourceList ?? this.getSources(option)
      if (!sourceList || sourceList.length === 0) return
      let complete = this.complete = new Complete(
        option,
        doc,
        this.config,
        sourceList,
        this.mru,
        this.nvim)
      complete.onDidRefresh(async () => {
        if (this.triggerTimer != null) {
          clearTimeout(this.triggerTimer)
        }
        if (this.hasInsert) return
        await this.filterResults()
      })
      let cancelled = await complete.doComplete()
      if (!cancelled && complete.isEmpty) {
        this.stop()
      }
    } catch (e) {
      this.stop()
      this.nvim.echoError(e)
    }
  }

  public getSources(option: CompleteOption): ISource[] {
    let { source } = option
    if (source) {
      let s = sources.getSource(source)
      return s ? [s] : []
    }
    return sources.getCompleteSources(option)
  }

  public hasSelected(): boolean {
    if (workspace.env.pumevent) return this.selectedItem != null
    // it's not correct
    if (!this.config.noselect) return true
    return false
  }

  private async showCompletion(items: ExtendedCompleteItem[]): Promise<void> {
    let { nvim, option } = this
    if (!option) return
    let { disableKind, labelMaxLength, disableMenuShortcut, disableMenu } = this.config
    let preselect = this.config.enablePreselect ? items.findIndex(o => o.preselect) : -1
    let validKeys = completeItemKeys.slice()
    if (disableKind) validKeys = validKeys.filter(s => s != 'kind')
    if (disableMenu) validKeys = validKeys.filter(s => s != 'menu')
    let vimItems = items.map(item => {
      let obj = { word: item.word, equal: 1 }
      for (let key of validKeys) {
        if (item.hasOwnProperty(key)) {
          if (disableMenuShortcut && key == 'menu') {
            obj[key] = item[key].replace(/\[.+\]$/, '')
          } else if (key == 'abbr' && item[key].length > labelMaxLength) {
            obj[key] = item[key].slice(0, labelMaxLength)
          } else {
            obj[key] = item[key]
          }
        }
      }
      return obj
    })
    if (vimItems.length) this.start()
    nvim.call('coc#_do_complete', [option.col, vimItems, preselect], true)
  }

  private async onTextChangedP(bufnr: number, info: InsertChange): Promise<void> {
    let { option, document } = this
    if (!option || option.bufnr != bufnr) return
    if ((info.insertChar || this.pretext == info.pre) && shouldIndent(option.indentkeys, info.pre)) {
      logger.debug(`trigger indent by ${info.pre}`)
      let indentChanged = await this.nvim.call('coc#complete_indent', [])
      if (indentChanged) {
        await this.triggerCompletion(document, info.pre)
        return
      }
    }
    if (this.pretext == info.pre) return
    let pretext = this.pretext = info.pre
    if (info.pre.match(/^\s*/)[0] !== option.line.match(/^\s*/)[0]) {
      await this.triggerCompletion(document, pretext)
      return
    }
    // Avoid resume when TextChangedP caused by <C-n> or <C-p>
    if (this.selectedItem && !info.insertChar) {
      let expected = byteSlice(option.line, 0, option.col) + this.selectedItem.word
      if (expected == pretext) {
        this.hasInsert = true
        return
      }
    }
    await this.filterResults()
  }

  private async onTextChangedI(bufnr: number, info: InsertChange): Promise<void> {
    if (!this.isEnabled(bufnr)) return
    let { option } = this
    if (option && shouldStop(bufnr, this.pretext, info, option)) {
      this.stop()
      if (!info.insertChar) return
    }
    if (info.pre === this.pretext) return
    if (this.triggerTimer) clearTimeout(this.triggerTimer)
    let pretext = this.pretext = info.pre
    let doc = workspace.getDocument(bufnr)
    // check commit
    if (this.activated && Is.vimCompleteItem(this.previousItem) && this.config.acceptSuggestionOnCommitCharacter) {
      let resolvedItem = this.getCompleteItem(this.previousItem)
      let last = pretext.slice(-1)
      if (sources.shouldCommit(resolvedItem, last)) {
        let { linenr, col, line, colnr } = this.option
        this.stop()
        let { word } = resolvedItem
        let newLine = `${line.slice(0, col)}${word}${info.insertChar}${line.slice(colnr - 1)}`
        await this.nvim.call('coc#util#setline', [linenr, newLine])
        let curcol = col + word.length + 2
        await this.nvim.call('cursor', [linenr, curcol])
        await doc.patchChange()
        return
      }
    }
    // trigger character
    if (info.insertChar && !isWord(info.insertChar)) {
      let disabled = doc.getVar('disabled_sources', [])
      let triggerSources = sources.getTriggerSources(pretext, doc.filetype, doc.uri, disabled)
      if (triggerSources.length > 0) {
        await this.triggerCompletion(doc, pretext, triggerSources)
        return
      }
    }
    // trigger by normal character
    if (!this.complete) {
      if (!info.insertChar) return
      await this.triggerCompletion(doc, pretext)
      return
    }
    if (info.insertChar && this.complete.isEmpty) {
      // triggering without results
      this.triggerTimer = setTimeout(async () => {
        await this.triggerCompletion(doc, pretext)
      }, 150)
      return
    }
    await this.filterResults()
  }

  private async triggerCompletion(doc: Document, pre: string, sources?: ISource[]): Promise<boolean> {
    // check trigger
    if (!sources) {
      let shouldTrigger = this.shouldTrigger(doc, pre)
      if (!shouldTrigger) return false
    }
    if (this.triggering) return false
    this.triggering = true
    let option = await this.nvim.call('coc#util#get_complete_option') as CompleteOption
    this.triggering = false
    if (!option) {
      logger.warn(`Completion of ${doc.bufnr} disabled by b:coc_suggest_disable`)
      return false
    }
    if (option.disabled?.length && sources) {
      sources = sources.filter(s => !option.disabled.includes(s.name))
      if (!sources.length) return false
    }
    // could be changed by indent
    pre = byteSlice(option.line, 0, option.colnr - 1)
    if (option.blacklist && option.blacklist.includes(option.input)) {
      logger.warn(`Suggest disabled by b:coc_suggest_blacklist`, option.blacklist)
      return false
    }
    if (option.input && this.config.asciiCharactersOnly) {
      option.input = this.getInput(doc, pre)
      option.col = byteLength(pre) - byteLength(option.input)
    }
    if (this.config.ignoreRegexps.length > 0 && option.input.length > 0) {
      const ignore = this.config.ignoreRegexps.some(regexp => {
        if (new RegExp(regexp).test(option.input)) {
          logger.warn(`Suggest disabled by ignore regexp: ${regexp}`)
          return true
        }
      })
      if (ignore) return false
    }
    if (pre.length) option.triggerCharacter = pre[pre.length - 1]
    await this.startCompletion(option, sources)
    return true
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    let { document, complete } = this
    if (!document || !Is.vimCompleteItem(item)) return
    let input = complete.input
    let opt = Object.assign({}, this.option)
    let resolvedItem = this.getCompleteItem(item)
    this.stop()
    if (!resolvedItem) return
    this.mru.add(input, resolvedItem)
    let insertChange = await waitTextChangedI()
    if (!insertChange) return
    if (insertChange.lnum != opt.linenr || insertChange.pre !== byteSlice(opt.line, 0, opt.col) + item.word) return
    let res = await events.race(['InsertCharPre', 'CursorMovedI'], 20)
    if (res) return
    let source = new CancellationTokenSource()
    let { token } = source
    await this.doCompleteResolve(resolvedItem, source)
    if (token.isCancellationRequested) return
    await this.doCompleteDone(resolvedItem, opt)
  }

  private doCompleteResolve(item: ExtendedCompleteItem, tokenSource: CancellationTokenSource): Promise<void> {
    let source = sources.getSource(item.source)
    return new Promise<void>(resolve => {
      if (source && typeof source.onCompleteResolve === 'function') {
        let timer = setTimeout(() => {
          tokenSource.cancel()
          logger.warn(`Resolve timeout after 500ms: ${source.name}`)
          resolve()
        }, 500)
        Promise.resolve(source.onCompleteResolve(item, tokenSource.token)).then(() => {
          clearTimeout(timer)
          resolve()
        }, e => {
          logger.error(`Error on complete resolve: ${e.message}`, e)
          clearTimeout(timer)
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  public async doCompleteDone(item: ExtendedCompleteItem, opt: CompleteOption): Promise<void> {
    let source = sources.getSource(item.source)
    if (source && typeof source.onCompleteDone === 'function') {
      await Promise.resolve(source.onCompleteDone(item, opt))
    }
  }

  private async onInsertEnter(bufnr: number): Promise<void> {
    if (!this.config.triggerAfterInsertEnter || this.config.autoTrigger !== 'always') return
    if (!this.isEnabled(bufnr)) return
    let pre = await this.nvim.eval(`strpart(getline('.'), 0, col('.') - 1)`) as string
    if (!pre) return
    let doc = workspace.getDocument(bufnr)
    await this.triggerCompletion(doc, pre)
  }

  public shouldTrigger(doc: Document, pre: string): boolean {
    let { autoTrigger, asciiCharactersOnly, minTriggerInputLength } = this.config
    if (autoTrigger == 'none') return false
    if (sources.shouldTrigger(pre, doc.filetype, doc.uri)) return true
    if (autoTrigger !== 'always') return false
    let last = pre.slice(-1)
    // eslint-disable-next-line no-control-regex
    if (asciiCharactersOnly && !/[\x00-\x7F]/.test(last)) {
      return false
    }
    if (last && (doc.isWord(last) || last.codePointAt(0) > 255)) {
      if (minTriggerInputLength == 1) return true
      let input = this.getInput(doc, pre)
      return input.length >= minTriggerInputLength
    }
    return false
  }

  private async onPumChange(): Promise<void> {
    if (!this.popupEvent) return
    let { col, row, height, width, scrollbar } = this.popupEvent
    let bounding: PumBounding = { col, row, height, width, scrollbar }
    let resolvedItem = this.getCompleteItem(this.selectedItem)
    if (!resolvedItem) {
      this.floating.close()
      return
    }
    let source = this.resolveTokenSource = new CancellationTokenSource()
    let { token } = source
    await this.doCompleteResolve(resolvedItem, source)
    if (token.isCancellationRequested) return
    let docs = resolvedItem.documentation
    if (!docs && resolvedItem.info) {
      let { info } = resolvedItem
      let isText = /^[\w-\s.,\t]+$/.test(info)
      docs = [{ filetype: isText ? 'txt' : this.document.filetype, content: info }]
    }
    if (!this.config.floatEnable) return
    if (!docs || docs.length == 0) {
      this.floating.close()
    } else {
      let excludeImages = workspace.getConfiguration('coc.preferences').get<boolean>('excludeImageLinksInMarkdownDocument')
      let config = Object.assign({}, this.config.floatConfig, { excludeImages })
      await this.floating.show(docs, bounding, config)
    }
  }

  public start(): void {
    if (this.activated) return
    this.activated = true
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${this.completeOpt}`, true)
    }
  }

  private cancelResolve(): void {
    if (this.resolveTokenSource) {
      this.resolveTokenSource.cancel()
      this.resolveTokenSource.dispose()
      this.resolveTokenSource = null
    }
  }

  public stop(): void {
    this.cancel()
    if (this.activated) {
      this.activated = false
      let { nvim, config } = this
      let completeOpt = config.keepCompleteopt ? '' : workspace.completeOpt
      nvim.call('coc#_cancel', [1, completeOpt], true)
      nvim.redrawVim()
    }
  }

  private getInput(document: Document, pre: string): string {
    let { asciiCharactersOnly } = this.config
    let input = ''
    for (let i = pre.length - 1; i >= 0; i--) {
      let ch = i == 0 ? null : pre[i - 1]
      // eslint-disable-next-line no-control-regex
      if (!ch || !document.isWord(ch) || (asciiCharactersOnly && !/[\x00-\x7F]/.test(ch))) {
        input = pre.slice(i, pre.length)
        break
      }
    }
    return input
  }

  public getResumeInput(): string {
    let { option, pretext, document } = this
    if (!option || !document) return null
    let buf = Buffer.from(pretext, 'utf8')
    if (buf.length < option.colnr - 1) return null
    let pre = byteSlice(option.line, 0, option.colnr - 1)
    if (!pretext.startsWith(pre)) return null
    let remain = pretext.slice(pre.length)
    if (remain.includes(' ')) return null
    let input = buf.slice(option.col).toString('utf8')
    if (input.length > 0 && option.blacklist && option.blacklist.includes(input)) return null
    return input
  }

  private async filterResults(): Promise<void> {
    let { complete } = this
    let search = this.getResumeInput()
    if (search == null) {
      this.stop()
      return
    }
    let items = await complete.filterResults(search)
    // cancelled
    if (items === undefined) return
    if (items.length == 0) {
      if (!complete.isCompleting) this.stop()
      return
    }
    await this.showCompletion(items)
  }

  public isEnabled(bufnr: number): boolean {
    let doc = workspace.getDocument(bufnr)
    if (!doc
      || !doc.attached
      || doc.getVar('suggest_disable', 0)) return false
    return this.config.autoTrigger !== 'none'
  }

  private get completeOpt(): string {
    let { noselect, enablePreview } = this.config
    let preview = enablePreview && !workspace.env.pumevent ? ',preview' : ''
    if (noselect) return `noselect,menuone${preview}`
    return `noinsert,menuone${preview}`
  }

  private getCompleteItem(item: VimCompleteItem | {} | null): ExtendedCompleteItem | null {
    if (!this.complete || !Is.vimCompleteItem(item)) return null
    return this.complete.resolveCompletionItem(item)
  }

  private cancel(): void {
    if (this.complete != null) {
      this.complete.dispose()
      this.complete = null
    }
    if (this.triggerTimer != null) {
      clearTimeout(this.triggerTimer)
      this.triggerTimer = null
    }
    this.cancelResolve()
    this.previousItem = undefined
    this.pretext = undefined
    this.hasInsert = false
  }

  public dispose(): void {
    this.cancelResolve()
    disposeAll(this.disposables)
  }
}

export default new Completion()
