import FlashCircleIcon from 'mdi-react/FlashCircleIcon'
import React from 'react'
import { Link } from 'react-router-dom'
import * as GQL from '../../../../../shared/src/graphql/schema'
import { ActorLink } from '../../../actor/ActorLink'
import { TimelineItem } from '../TimelineItem'

interface Props {
    event: GQL.IRequestReviewEvent

    className?: string
}

export const MergeThreadEventTimelineItem: React.FunctionComponent<Props> = ({ event, className = '' }) => (
    <TimelineItem icon={FlashCircleIcon} className={className} iconClassName="text-success" event={event}>
        <ActorLink actor={event.actor} /> merged <Link to={event.thread.url}>{event.thread.title}</Link>
    </TimelineItem>
)