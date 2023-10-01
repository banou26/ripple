import * as HoverCard from '@radix-ui/react-hover-card'
import { ReactNode, useState } from 'react'
import { css } from '@emotion/react'

const style = css`
  padding: 1rem;
  background: #0f0f0f;
  border-radius: 0.8rem;
  box-shadow: 0 0.4rem 1.6rem rgba(0, 0, 0, 0.1);
  color: #fff;
  font-size: 1.4rem;
  font-weight: 400;
  line-height: 2.4rem;
  text-align: center;
  z-index: 1301;
  overflow: hidden;
  overflow-wrap: anywhere;
`

interface TooltipProps {
  tooltipChildren: ReactNode;
  children: ReactNode;
}

export const Tooltip = ({ tooltipChildren, children }: TooltipProps) => {
  return (
    <HoverCard.Root openDelay={300}>
      <HoverCard.Trigger asChild>
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content sideOffset={5} css={style} side='top'>
          {tooltipChildren}
          <HoverCard.Arrow />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
    )
}