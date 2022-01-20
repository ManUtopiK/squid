import {Range} from "../util/range"
import {BlockHandler, EventHandler, ExtrinsicHandler} from "./handlerContext"
import {ContractAddress, QualifiedName} from "./substrate"


export interface BlockHook {
    handler: BlockHandler
    range?: Range
}


export interface EventHook {
    handler: EventHandler
    event: QualifiedName
    range?: Range
}

export interface EvmLogHook {
    handler: EventHandler
    contractAddress: ContractAddress
    topics?: string[]
    range?: Range
}


export interface ExtrinsicHook {
    handler: ExtrinsicHandler
    event: QualifiedName
    extrinsic: QualifiedName
    range?: Range
}


export interface Hooks {
    pre: BlockHook[]
    post: BlockHook[]
    event: EventHook[]
    extrinsic: ExtrinsicHook[]
    evmLog: EvmLogHook[]
}
