import * as H from 'history'
import { isEqual } from 'lodash'
import * as React from 'react'
import { concat, fromEvent, merge, Observable, ObservableInput, of, Subject, Subscription } from 'rxjs'
import {
    catchError,
    debounceTime,
    delay,
    distinctUntilChanged,
    filter,
    first,
    map,
    share,
    switchMap,
    takeUntil,
    tap,
    withLatestFrom,
} from 'rxjs/operators'
import { Hover, Position } from 'vscode-languageserver-types'
import { AbsoluteRepoFile, RenderMode } from '..'
import { EMODENOTFOUND, fetchHover, fetchJumpURL, isEmptyHover } from '../../backend/lsp'
import { eventLogger } from '../../tracking/eventLogger'
import { scrollIntoView } from '../../util'
import { asError, ErrorLike, isErrorLike } from '../../util/errors'
import { isDefined, propertyIsDefined } from '../../util/types'
import { parseHash, toPositionOrRangeHash } from '../../util/url'
import { BlameLine } from './blame/BlameLine'
import { HoverOverlay, isJumpURL } from './HoverOverlay'
import { convertNode, findElementWithOffset, getTableDataCell, getTargetLineAndOffset } from './tooltips'

/**
 * Returns the token `<span>` element in a `<code>` element for a given zero-based position.
 */
const getTokenAtPosition = (codeElement: HTMLElement, position: Position): HTMLElement | undefined => {
    const table = codeElement.firstElementChild as HTMLTableElement
    const row = table.rows.item(position.line)
    if (!row) {
        return undefined
    }
    return findElementWithOffset(row, position.character + 1)
}

/**
 * `padding-top` of the blob element in px.
 * TODO find a way to remove the need for this.
 */
const BLOB_PADDING_TOP = 8

/**
 * Calculates the desired position of the hover overlay depending on the container,
 * the hover target and the size of the hover overlay
 *
 * @param scrollable The closest container that is scrollable
 * @param target The DOM Node that was hovered
 * @param tooltip The DOM Node of the tooltip
 */
const calculateOverlayPosition = (
    scrollable: HTMLElement,
    target: HTMLElement,
    tooltip: HTMLElement
): { left: number; top: number } => {
    // The scrollable element is the one with scrollbars. The scrolling element is the one with the content.
    const scrollableBounds = scrollable.getBoundingClientRect()
    const scrollingElement = scrollable.firstElementChild! // table that we're positioning tooltips relative to.
    const scrollingBounds = scrollingElement.getBoundingClientRect() // tables bounds
    const targetBound = target.getBoundingClientRect() // our target elements bounds

    // Anchor it horizontally, prior to rendering to account for wrapping
    // changes to vertical height if the tooltip is at the edge of the viewport.
    const relLeft = targetBound.left - scrollingBounds.left

    // Anchor the tooltip vertically.
    const tooltipBound = tooltip.getBoundingClientRect()
    const relTop = targetBound.top + scrollable.scrollTop - scrollableBounds.top
    // This is the padding-top of the blob element
    let tooltipTop = relTop - (tooltipBound.height - BLOB_PADDING_TOP)
    if (tooltipTop - scrollable.scrollTop < 0) {
        // Tooltip wouldn't be visible from the top, so display it at the
        // bottom.
        const relBottom = targetBound.bottom + scrollable.scrollTop - scrollableBounds.top
        tooltipTop = relBottom
    } else {
        tooltipTop -= BLOB_PADDING_TOP
    }
    return { left: relLeft, top: tooltipTop }
}

interface HightlightArgs {
    /** The `<code>` element */
    codeElement: HTMLElement
    /** The table row that represents the new line */
    line?: HTMLTableRowElement
}

/**
 * Sets a new line to be highlighted and unhighlights the previous highlighted line, if exists.
 */
const highlightLine = ({ line, codeElement }: HightlightArgs): void => {
    const current = codeElement.querySelector('.selected')
    if (current) {
        current.classList.remove('selected')
    }
    if (line === undefined) {
        return
    }

    line.classList.add('selected')
}

const scrollToCenter = (blobElement: HTMLElement, codeElement: HTMLElement, tableRow: HTMLElement) => {
    // if theres a position hash on page load, scroll it to the center of the screen
    const blobBound = blobElement.getBoundingClientRect()
    const codeBound = codeElement.getBoundingClientRect()
    const rowBound = tableRow.getBoundingClientRect()
    const scrollTop = rowBound.top - codeBound.top - blobBound.height / 2 + rowBound.height / 2

    blobElement.scrollTop = scrollTop
}

/**
 * toPortalID builds an ID that will be used for the blame portal containers.
 */
const toPortalID = (line: number) => `blame-portal-${line}`

interface BlobProps extends AbsoluteRepoFile {
    /** The trusted syntax-highlighted code as HTML */
    html: string

    location: H.Location
    history: H.History
    className: string
    wrapCode: boolean
    renderMode: RenderMode
}

const LOADING: 'loading' = 'loading'

const isHover = (val: any): val is Hover => typeof val === 'object' && val !== null && Array.isArray(val.contents)

interface BlobState {
    hoverOrError?: typeof LOADING | Hover | null | ErrorLike
    definitionURLOrError?: typeof LOADING | { jumpURL: string } | null | ErrorLike
    hoverOverlayIsFixed: boolean

    /** The desired position of the hover overlay */
    hoverOverlayPosition?: { left: number; top: number }

    /**
     * Whether the user has clicked the go to definition button for the current overlay yet,
     * and whether he pressed Ctrl/Cmd while doing it to open it in a new tab or not.
     */
    clickedGoToDefinition: false | 'same-tab' | 'new-tab'

    /** The currently hovered token */
    hoveredTokenPosition?: Position

    /**
     * blameLineIDs is a map from line numbers with portal nodes created to portal IDs.
     * It's used to render the portals for blames. The line numbers are taken from the blob
     * so they are 1-indexed.
     */
    blameLineIDs: { [key: number]: string }

    activeLine: number | null

    mouseIsMoving: boolean
}

/**
 * Returns true if the HoverOverlay component should be rendered according to the given state.
 * The HoverOverlay is rendered when there is either a non-empty hover result or a non-empty definition result.
 */
const shouldRenderHover = (state: BlobState): boolean =>
    !(!state.hoverOverlayIsFixed && state.mouseIsMoving) &&
    ((state.hoverOrError && !(isHover(state.hoverOrError) && isEmptyHover(state.hoverOrError))) ||
        isJumpURL(state.definitionURLOrError))

/** The time in ms after which to show a loader if the result has not returned yet */
const LOADER_DELAY = 100

/** The time in ms after the mouse has stopped moving in which to show the tooltip */
const TOOLTIP_DISPLAY_DELAY = 100

export class Blob2 extends React.Component<BlobProps, BlobState> {
    /** Emits with the latest Props on every componentDidUpdate and on componentDidMount */
    private componentUpdates = new Subject<BlobProps>()

    /** Emits whenever the ref callback for the code element is called */
    private codeElements = new Subject<HTMLElement | null>()
    private nextCodeElement = (element: HTMLElement | null) => this.codeElements.next(element)

    /** Emits whenever the ref callback for the blob element is called */
    private blobElements = new Subject<HTMLElement | null>()
    private nextBlobElement = (element: HTMLElement | null) => this.blobElements.next(element)

    /** Emits whenever the ref callback for the hover element is called */
    private hoverOverlayElements = new Subject<HTMLElement | null>()
    private nextOverlayElement = (element: HTMLElement | null) => this.hoverOverlayElements.next(element)

    /** Emits whenever something is hovered in the code */
    private codeMouseOvers = new Subject<React.MouseEvent<HTMLElement>>()
    private nextCodeMouseOver = (event: React.MouseEvent<HTMLElement>) => this.codeMouseOvers.next(event)

    /** Emits whenever something is clicked in the code */
    private codeClicks = new Subject<React.MouseEvent<HTMLElement>>()
    private nextCodeClick = (event: React.MouseEvent<HTMLElement>) => {
        event.persist()
        this.codeClicks.next(event)
    }

    /** Emits when the go to definition button was clicked */
    private goToDefinitionClicks = new Subject<React.MouseEvent<HTMLElement>>()
    private nextGoToDefinitionClick = (event: React.MouseEvent<HTMLElement>) => this.goToDefinitionClicks.next(event)

    /** Emits when the close button was clicked */
    private closeButtonClicks = new Subject<React.MouseEvent<HTMLElement>>()
    private nextCloseButtonClick = (event: React.MouseEvent<HTMLElement>) => this.closeButtonClicks.next(event)

    /** Subscriptions to be disposed on unmout */
    private subscriptions = new Subscription()

    constructor(props: BlobProps) {
        super(props)
        this.state = {
            hoverOverlayIsFixed: false,
            clickedGoToDefinition: false,
            blameLineIDs: {},
            activeLine: null,
            mouseIsMoving: false,
        }

        // Mouse is moving, don't show the tooltip
        this.subscriptions.add(
            this.codeMouseOvers.subscribe(() => {
                this.setState({ mouseIsMoving: true })
            })
        )

        // Mouse stopped over a token for TOOLTIP_DISPLAY_DELAY, show tooltip
        this.subscriptions.add(
            this.codeMouseOvers.pipe(debounceTime(TOOLTIP_DISPLAY_DELAY)).subscribe(() => {
                this.setState({ mouseIsMoving: false })
            })
        )

        const codeMouseOverTargets = this.codeMouseOvers.pipe(
            map(event => event.target as HTMLElement),
            // Casting is okay here, we know these are HTMLElements
            withLatestFrom(this.codeElements),
            // If there was a mouseover, there _must_ have been a blob element
            map(([target, codeElement]) => ({ target, codeElement: codeElement! })),
            debounceTime(50),
            // SIDE EFFECT (but idempotent)
            // If not done for this cell, wrap the tokens in this cell to enable finding the precise positioning.
            // This may be possible in other ways (looking at mouse position and rendering characters), but it works
            tap(({ target, codeElement }) => {
                const td = getTableDataCell(target, codeElement)
                if (td && !td.classList.contains('annotated')) {
                    convertNode(td)
                    td.classList.add('annotated')
                }
            }),
            share()
        )

        /**
         * lineClickElements gets the full row that was clicked, the line number cell, the code cell,
         * and the line number itself.
         */
        const lineClickElements = this.codeClicks.pipe(
            map(({ target }) => target as HTMLElement),
            map(target => {
                let row: HTMLElement | null = target
                while (row.parentElement && row.tagName !== 'TR') {
                    row = row.parentElement
                }
                return { target, row }
            }),
            filter(propertyIsDefined('row')),
            map(({ target, row }) => {
                const lineNumberCell = row.children.item(0) as HTMLElement
                const codeCell = row.children.item(1) as HTMLElement
                const lineNumber = parseInt(lineNumberCell.dataset.line!, 10)
                return { target, row, lineNumberCell, lineNumber, codeCell }
            })
        )

        // Highlight the clicked row
        this.subscriptions.add(
            lineClickElements
                .pipe(
                    withLatestFrom(this.codeElements),
                    map(([{ row }, codeElement]) => ({ line: row, codeElement })),
                    filter(propertyIsDefined('codeElement'))
                )
                .subscribe(highlightLine)
        )

        // When clicking a line, update the URL (which will in turn trigger a highlight of the line)
        this.subscriptions.add(
            lineClickElements
                .pipe(
                    withLatestFrom(this.codeElements),
                    map(([{ target, lineNumber }, codeElement]) => ({ target, lineNumber, codeElement })),
                    filter(propertyIsDefined('codeElement')),
                    map(({ target, lineNumber, codeElement }) => ({
                        lineNumber,
                        position: getTargetLineAndOffset(target, codeElement!, false),
                    }))
                )
                .subscribe(({ position, lineNumber }) => {
                    let hash: string
                    if (position !== undefined) {
                        hash = toPositionOrRangeHash({ position })
                    } else {
                        hash = `#L${lineNumber}`
                    }

                    if (!hash.startsWith('#')) {
                        hash = '#' + hash
                    }

                    this.props.history.push({
                        ...this.props.location,
                        hash,
                    })
                })
        )

        const codeClickTargets = this.codeClicks.pipe(
            map(event => event.target as HTMLElement),
            withLatestFrom(this.codeElements),
            // If there was a click, there _must_ have been a blob element
            map(([target, codeElement]) => ({ target, codeElement: codeElement! })),
            share()
        )

        /** Emits new positions found in the URL */
        const positionsFromLocationHash: Observable<Position> = this.componentUpdates.pipe(
            map(props => parseHash(props.location.hash)),
            filter(Position.is),
            map(position => ({ line: position.line, character: position.character })),
            distinctUntilChanged((a, b) => isEqual(a, b)),
            share()
        )

        /** Emits DOM elements at new positions found in the URL */
        const targetsFromLocationHash: Observable<{
            target: HTMLElement
            codeElement: HTMLElement
        }> = positionsFromLocationHash.pipe(
            withLatestFrom(this.codeElements),
            map(([position, codeElement]) => ({ position, codeElement })),
            filter(propertyIsDefined('codeElement')),
            map(({ position, codeElement }) => {
                const table = codeElement.firstElementChild as HTMLTableElement
                const row = table.rows[position.line - 1]
                if (!row) {
                    alert(`Could not find line ${position.line} in file`)
                    return { codeElement }
                }
                const cell = row.cells[1]
                const target = findElementWithOffset(cell, position.character)
                if (!target) {
                    console.warn('Could not find target for position in file', position)
                }
                return { target, codeElement }
            }),
            filter(propertyIsDefined('target'))
        )

        // REPOSITIONING
        // On every componentDidUpdate (after the component was rerendered, e.g. from a hover state update) resposition
        // the tooltip
        // It's important to add this subscription first so that withLatestFrom will be guaranteed to have gotten the
        // latest hover target by the time componentDidUpdate is triggered from the setState() in the second chain
        this.subscriptions.add(
            // Take every rerender
            this.componentUpdates
                .pipe(
                    // with the latest target that came from either a mouseover, click or location change (whatever was the most recent)
                    withLatestFrom(
                        merge(
                            codeMouseOverTargets.pipe(map(data => ({ ...data, source: 'mouseover' as 'mouseover' }))),
                            codeClickTargets.pipe(map(data => ({ ...data, source: 'click' as 'click' }))),
                            targetsFromLocationHash.pipe(map(data => ({ ...data, source: 'location' as 'location' })))
                        )
                    ),
                    map(([, { target, codeElement, source }]) => ({ target, codeElement, source })),
                    // When the new target came from a mouseover, only reposition the hover if it is not fixed
                    filter(({ source }) => source !== 'mouseover' || !this.state.hoverOverlayIsFixed),
                    withLatestFrom(this.hoverOverlayElements),
                    map(([{ target, codeElement }, hoverElement]) => ({ target, hoverElement, codeElement })),
                    filter(propertyIsDefined('hoverElement'))
                )
                .subscribe(({ codeElement, hoverElement, target }) => {
                    const hoverOverlayPosition = calculateOverlayPosition(
                        codeElement.parentElement!, // ! because we know its there
                        target,
                        hoverElement
                    )
                    this.setState({ hoverOverlayPosition })
                })
        )

        // Add a dom node for the blame portals
        this.subscriptions.add(lineClickElements.subscribe(this.createBlameDomNode))

        // Set the currently active line from hover
        this.subscriptions.add(
            lineClickElements.pipe(map(({ lineNumber }) => lineNumber)).subscribe(activeLine => {
                this.setState({ activeLine })
            })
        )

        /**
         * Emits with the position at which a new tooltip is to be shown from a mouseover, click or location change.
         * Emits `undefined` when a target was hovered/clicked that does not correspond to a position (e.g. after the end of the line).
         */
        const filteredTargetPositions: Observable<{ position?: Position; target: HTMLElement }> = merge(
            merge(
                // When the location changes and and includes a line/column pair, use that target
                targetsFromLocationHash,
                // mouseovers should only trigger a new hover when the overlay is not fixed
                codeMouseOverTargets.pipe(filter(() => !this.state.hoverOverlayIsFixed)),
                // clicks should trigger a new hover when the overlay is fixed
                codeClickTargets.pipe(filter(() => this.state.hoverOverlayIsFixed))
            ).pipe(
                // Find out the position that was hovered over
                map(({ target, codeElement }) => {
                    const hoveredToken = getTargetLineAndOffset(target, codeElement, false)
                    return {
                        target,
                        position: hoveredToken && { line: hoveredToken.line, character: hoveredToken.character },
                    }
                }),
                distinctUntilChanged((a, b) => isEqual(a.position, b.position))
            )
        ).pipe(share())

        // HOVER FETCH
        // On every new hover position, fetch new hover contents
        const hovers = filteredTargetPositions.pipe(
            switchMap(({ target, position }): ObservableInput<{
                target: HTMLElement
                position?: Position
                hoverOrError?: Hover | null | ErrorLike | typeof LOADING
            }> => {
                if (!position) {
                    return [{ target, position, hoverOrError: undefined }]
                }
                // Fetch the hover for that position
                const hoverFetch = fetchHover({
                    repoPath: this.props.repoPath,
                    commitID: this.props.commitID,
                    filePath: this.props.filePath,
                    rev: this.props.rev,
                    position,
                }).pipe(
                    catchError(error => {
                        if (error && error.code === EMODENOTFOUND) {
                            return [undefined]
                        }
                        return [asError(error)]
                    }),
                    share()
                )
                // Show a loader if it hasn't returned after 100ms
                return merge(hoverFetch, of(LOADING).pipe(delay(LOADER_DELAY), takeUntil(hoverFetch))).pipe(
                    map(hoverOrError => ({ target, position, hoverOrError }))
                )
            }),
            share()
        )
        // Update the state
        this.subscriptions.add(
            hovers.subscribe(({ target, position, hoverOrError }) => {
                this.setState(state => ({
                    hoverOrError,
                    // Reset the hover position, it's gonna be repositioned after the hover was rendered
                    hoverOverlayPosition: undefined,
                    // After the hover is fetched, if the overlay was pinned, unpin it if the hover is empty
                    hoverOverlayIsFixed: state.hoverOverlayIsFixed
                        ? !!hoverOrError || !isHover(hoverOrError) || !isEmptyHover(hoverOrError)
                        : false,
                }))
                // Telemetry
                if (hoverOrError && hoverOrError !== LOADING && !isErrorLike(hoverOrError)) {
                    eventLogger.log('SymbolHovered')
                }
            })
        )
        // Highlight the hover range returned by the language server
        this.subscriptions.add(
            hovers.pipe(withLatestFrom(this.codeElements)).subscribe(([{ hoverOrError }, codeElement]) => {
                const currentHighlighted = codeElement!.querySelector('.selection-highlight')
                if (currentHighlighted) {
                    currentHighlighted.classList.remove('selection-highlight')
                }
                if (!isHover(hoverOrError) || !hoverOrError.range) {
                    return
                }
                const token = getTokenAtPosition(codeElement!, hoverOrError.range.start)
                if (!token) {
                    return
                }
                token.classList.add('selection-highlight')
            })
        )

        // GO TO DEFINITION FETCH
        // On every new hover position, (pre)fetch definition and update the state
        this.subscriptions.add(
            filteredTargetPositions
                .pipe(
                    // Fetch the definition location for that position
                    switchMap(({ position }) => {
                        if (!position) {
                            return [undefined]
                        }
                        return concat(
                            [LOADING],
                            fetchJumpURL({
                                repoPath: this.props.repoPath,
                                commitID: this.props.commitID,
                                filePath: this.props.filePath,
                                rev: this.props.rev,
                                position,
                            }).pipe(
                                map(url => (url !== null ? { jumpURL: url } : null)),
                                catchError(error => [asError(error)])
                            )
                        )
                    })
                )
                .subscribe(definitionURLOrError => {
                    this.setState({ definitionURLOrError })
                    // If the j2d button was already clicked and we now have the result, jump to it
                    if (this.state.clickedGoToDefinition && isJumpURL(definitionURLOrError)) {
                        switch (this.state.clickedGoToDefinition) {
                            case 'same-tab':
                                this.props.history.push(definitionURLOrError.jumpURL)
                                break
                            case 'new-tab':
                                window.open(definitionURLOrError.jumpURL, '_blank')
                                break
                        }
                    }
                })
        )

        // On every click on a go to definition button, reveal loader/error/not found UI
        this.subscriptions.add(
            this.goToDefinitionClicks.subscribe(event => {
                // Telemetry
                eventLogger.log('GoToDefClicked')

                // This causes an error/loader/not found UI to get shown if needed
                // Remember if ctrl/cmd was pressed to determine whether the definition should be opened in a new tab once loaded
                this.setState({ clickedGoToDefinition: event.ctrlKey || event.metaKey ? 'new-tab' : 'same-tab' })

                // If we don't have a result yet, prevent default link behaviour (jump will occur dynamically once finished)
                if (!isJumpURL(this.state.definitionURLOrError)) {
                    event.preventDefault()
                }
            })
        )
        this.subscriptions.add(
            filteredTargetPositions.subscribe(({ position }) => {
                this.setState({
                    hoveredTokenPosition: position,
                    // On every new target (from mouseover or click) hide the j2d loader/error/not found UI again
                    clickedGoToDefinition: false,
                })
            })
        )

        // HOVER OVERLAY PINNING ON CLICK
        this.subscriptions.add(
            codeClickTargets.subscribe(({ target, codeElement }) => {
                this.setState({
                    // If a token inside a code cell was clicked, pin the hover
                    // Otherwise if empty space was clicked, unpin it
                    hoverOverlayIsFixed: !target.matches('td'),
                })
            })
        )

        // When the close button is clicked, unpin, hide and reset the hover
        this.subscriptions.add(
            merge(
                this.closeButtonClicks,
                fromEvent<KeyboardEvent>(window, 'keydown').pipe(filter(event => event.key === 'Escape'))
            ).subscribe(event => {
                event.preventDefault()
                this.setState({
                    hoverOverlayIsFixed: false,
                    hoverOverlayPosition: undefined,
                    hoverOrError: undefined,
                    hoveredTokenPosition: undefined,
                    definitionURLOrError: undefined,
                    clickedGoToDefinition: false,
                })
            })
        )

        // When the blob loads, highlight the active line and scroll it to center of viewport
        //
        // THIS OBSERVABLE CHAIN ONLY EMITS ONCE
        this.subscriptions.add(
            this.componentUpdates
                .pipe(
                    map(props => {
                        const position = parseHash(props.location.hash)
                        return { line: position.line, character: position.character }
                    }),
                    distinctUntilChanged(),
                    withLatestFrom(this.codeElements.pipe(filter(isDefined))),
                    first(([, codeElement]) => !!codeElement),
                    map(([position, codeElement]) => ({ position, codeElement })),
                    filter(({ position: { line } }) => !!line),
                    map(({ position, codeElement }) => {
                        const lineElem = codeElement.querySelector(`td[data-line="${position.line}"]`)
                        if (lineElem && lineElem.parentElement) {
                            return { position, codeElement, tableRow: lineElem.parentElement as HTMLTableRowElement }
                        }

                        return { position, codeElement, tableRow: undefined }
                    }),
                    filter(propertyIsDefined('tableRow')),
                    withLatestFrom(this.blobElements.pipe(filter(isDefined)))
                )
                .subscribe(([{ position, tableRow, codeElement }, blobElement]) => {
                    highlightLine({ codeElement, line: tableRow })

                    // ! because we filtered out undefined lines above
                    const lineNumber = position.line!

                    const codeCell = tableRow.children.item(1) as HTMLElement
                    this.createBlameDomNode({
                        lineNumber,
                        codeCell,
                    })
                    convertNode(codeCell)

                    // if theres a position hash on page load, scroll it to the center of the screen
                    scrollToCenter(blobElement, codeElement, tableRow)
                    this.setState({ activeLine: lineNumber, hoverOverlayIsFixed: position.character !== undefined })
                })
        )

        // When the line in the location changes, scroll to it
        this.subscriptions.add(
            this.componentUpdates
                .pipe(
                    map(props => parseHash(props.location.hash).line),
                    distinctUntilChanged(),
                    withLatestFrom(this.blobElements.pipe(filter(isDefined)), this.codeElements.pipe(filter(isDefined)))
                )
                .subscribe(([line, blobElement, codeElement]) => {
                    const tableElement = codeElement.firstElementChild as HTMLTableElement
                    if (line !== undefined) {
                        const row = tableElement.rows[line - 1]
                        if (!row) {
                            return
                        }

                        if (this.state.clickedGoToDefinition) {
                            scrollToCenter(blobElement, codeElement, row)
                            highlightLine({ codeElement, line: row })
                        } else {
                            scrollIntoView(blobElement, row)
                        }
                    }
                })
        )
    }

    public componentDidMount(): void {
        this.componentUpdates.next(this.props)
    }

    public shouldComponentUpdate(nextProps: Readonly<BlobProps>, nextState: Readonly<BlobState>): boolean {
        return !isEqual(this.props, nextProps) || !isEqual(this.state, nextState)
    }

    public componentDidUpdate(): void {
        this.componentUpdates.next(this.props)
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public render(): React.ReactNode {
        const blamelineNumber = this.state.activeLine
        let blamePortalID: string | null = null

        if (blamelineNumber) {
            blamePortalID = this.state.blameLineIDs[blamelineNumber]
        }

        return (
            <div className={`blob2 ${this.props.className}`} ref={this.nextBlobElement}>
                <code
                    className={`blob2__code ${this.props.wrapCode ? ' blob2__code--wrapped' : ''} `}
                    ref={this.nextCodeElement}
                    dangerouslySetInnerHTML={{ __html: this.props.html }}
                    onClick={this.nextCodeClick}
                    onMouseOver={this.nextCodeMouseOver}
                    data-e2e="blob"
                />
                {shouldRenderHover(this.state) && (
                    <HoverOverlay
                        hoverRef={this.nextOverlayElement}
                        definitionURLOrError={
                            // always modify the href, but only show error/loader/not found after the button was clicked
                            isJumpURL(this.state.definitionURLOrError) || this.state.clickedGoToDefinition
                                ? this.state.definitionURLOrError
                                : undefined
                        }
                        onGoToDefinitionClick={this.nextGoToDefinitionClick}
                        onCloseButtonClick={this.nextCloseButtonClick}
                        hoverOrError={this.state.hoverOrError}
                        hoveredTokenPosition={this.state.hoveredTokenPosition}
                        overlayPosition={this.state.hoverOverlayPosition}
                        showCloseButton={this.state.hoverOverlayIsFixed}
                        {...this.props}
                    />
                )}
                {blamelineNumber &&
                    blamePortalID && (
                        <BlameLine
                            key={blamePortalID}
                            portalID={blamePortalID}
                            line={blamelineNumber}
                            {...this.props}
                        />
                    )}
            </div>
        )
    }

    private createBlameDomNode = ({ lineNumber, codeCell }: { lineNumber: number; codeCell: HTMLElement }): void => {
        const portalNode = document.createElement('span')

        const id = toPortalID(lineNumber)
        portalNode.id = id
        portalNode.classList.add('blame-portal')

        codeCell.appendChild(portalNode)

        this.setState({
            blameLineIDs: {
                ...this.state.blameLineIDs,
                [lineNumber]: id,
            },
        })
    }
}
