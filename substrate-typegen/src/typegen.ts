import {
    ChainDescription,
    decodeMetadata,
    getChainDescriptionFromMetadata,
    OldTypesBundle,
    QualifiedName,
    SpecVersion,
    Type
} from "@subsquid/substrate-metadata"
import * as eac from "@subsquid/substrate-metadata/lib/events-and-calls"
import {getTypesFromBundle} from "@subsquid/substrate-metadata/lib/old/typesBundle"
import {def, OutDir, toCamelCase} from "@subsquid/util"
import assert from "assert"
import {Interfaces} from "./ifs"
import {groupBy, upperCaseFirst} from "./util"


export interface ChainVersion {
    specVersion: SpecVersion
    blockNumber: number
    blockHash: string
    metadata: string
}


export interface TypegenOptions {
    outDir: string
    chainVersions: ChainVersion[]
    typesBundle?: OldTypesBundle
    events?: string[] | boolean
    calls?: string[] | boolean
}


export class Typegen {
    static generate(options: TypegenOptions): void {
        new Typegen(options).generate()
    }

    private interfaces = new Map<SpecVersion, Interfaces>()
    private dir: OutDir

    constructor(private options: TypegenOptions) {
        this.dir = new OutDir(options.outDir)
    }

    generate(): void {
        this.dir.del()
        this.generateItems('events')
        this.generateItems('calls')
        this.interfaces.forEach((ifs, specVersion) => {
            if (ifs.isEmpty()) return
            let file = this.dir.file(`v${specVersion}.ts`)
            ifs.generate(file)
            file.write()
        })
        this.dir.add('support.ts', [__dirname, '../src/support.ts'])
    }

    private generateItems(kind: 'events' | 'calls'): void {
        let items = this.collectItems(kind)
        if (items.size == 0) return

        let out = this.dir.file(`${kind}.ts`)
        let fix = kind == 'events' ? 'Event' : 'Call'
        let ctx = kind == 'events' ? 'event' : 'extrinsic'
        let names = Array.from(items.keys()).sort()
        let importedInterfaces = new Set<SpecVersion>()

        out.line(`import assert from 'assert'`)
        out.line(`import {${fix}Context, Result, deprecateLatest} from './support'`)
        out.lazy(() => Array.from(importedInterfaces).sort().map(v => `import * as v${v} from './v${v}'`))
        names.forEach(name => {
            let versions = items.get(name)!
            let {def: {pallet, name: unqualifiedName}} = versions[0]
            let className = upperCaseFirst(toCamelCase(`${pallet}_${unqualifiedName}`)) + fix
            out.line()
            out.block(`export class ${className}`, () => {
                out.block(`constructor(private ctx: ${fix}Context)`, () => {
                    let camelCased = toCamelCase(pallet) + '.' + toCamelCase(unqualifiedName)
                    if (camelCased == name || ctx == 'event') {
                        out.line(`assert(this.ctx.${ctx}.name === '${name}')`)
                    } else {
                        out.line(`assert(this.ctx.${ctx}.name === '${camelCased}' || this.ctx.${ctx}.name === '${name}')`)
                    }
                })
                versions.forEach((version, idx) => {
                    let isLatest = versions.length === idx + 1
                    let v = version.chain.specVersion
                    let ifs = this.getInterface(v)
                    let unqualifiedTypeExp: string
                    if (version.def.fields[0]?.name == null) {
                        unqualifiedTypeExp = ifs.makeTuple(version.def.fields.map(f => f.type))
                    } else {
                        unqualifiedTypeExp = `{${version.def.fields.map(f => `${f.name}: ${ifs.use(f.type)}`).join(', ')}}`
                    }
                    let typeExp = ifs.qualify('v'+v, unqualifiedTypeExp)
                    if (typeExp != unqualifiedTypeExp) {
                        importedInterfaces.add(v)
                    }
                    out.line()
                    out.blockComment(version.def.docs)
                    out.block(`get isV${v}(): boolean`, () => {
                        let hash = version.chain[kind].getHash(name)
                        out.line(`return this.ctx._chain.get${fix}Hash('${name}') === '${hash}'`)
                    })
                    out.line()
                    out.blockComment(version.def.docs)
                    out.block(`get asV${v}(): ${typeExp}`, () => {
                        out.line(`assert(this.isV${v})`)
                        out.line(`return this.ctx._chain.decode${fix}(this.ctx.${ctx})`)
                    })
                    if (isLatest) {
                        out.line()
                        out.block(`get isLatest(): boolean`, () => {
                            out.line(`deprecateLatest()`)
                            out.line(`return this.isV${v}`)
                        })
                        out.line()
                        out.block(`get asLatest(): ${typeExp}`, () => {
                            out.line(`deprecateLatest()`)
                            out.line(`return this.asV${v}`)
                        })
                    }
                })
            })
        })

        out.write()
    }

    /**
     * Create a mapping between qualified name and list of unique versions
     */
    private collectItems(kind: 'events' | 'calls'): Map<QualifiedName, Item[]> {
        let request = this.options[kind]
        if (!request) return new Map()
        let requested = Array.isArray(request) ? new Set(request) : undefined
        if (requested?.size === 0) return new Map()

        let list = this.chain().flatMap(chain => {
            return Object.entries(chain[kind].definitions).map(([name, def]) => {
                return {name, def, chain}
            })
        })

        let items = groupBy(list, i => i.name)
        requested?.forEach(name => {
            if (!items.has(name)) {
                throw new Error(`${name} is not defined by the chain metadata`)
            }
        })

        items.forEach((versions, name) => {
            if (requested == null || requested.has(name)) {
                versions.sort((a, b) => a.chain.blockNumber - b.chain.blockNumber)
                let unique: Item[] = []
                versions.forEach(v => {
                    let prev = unique.length ? unique[unique.length - 1] : undefined
                    if (prev && v.chain[kind].getHash(name) == prev.chain[kind].getHash(name)) {
                        // TODO: use the latest definition, but set specVersion and blockNumber of a previous one
                        // for hopefully better docs
                    } else {
                        unique.push(v)
                    }
                })
                items.set(name, unique)
            } else {
                items.delete(name)
            }
        })

        return items
    }

    @def
    chain(): VersionDescription[] {
        return this.options.chainVersions.map(v => {
            let metadata = decodeMetadata(v.metadata)
            let oldTypes = this.options.typesBundle && getTypesFromBundle(this.options.typesBundle, v.specVersion)
            let d = getChainDescriptionFromMetadata(metadata, oldTypes)
            return {
                specVersion: v.specVersion,
                blockNumber: v.blockNumber,
                types: d.types,
                events: new eac.Registry(d.types, d.event),
                calls: new eac.Registry(d.types, d.call),
                description: d
            }
        }).sort((a, b) => a.blockNumber - b.blockNumber)
    }

    getInterface(specVersion: SpecVersion): Interfaces {
        let ifs = this.interfaces.get(specVersion)
        if (ifs) return ifs
        let d = this.chain().find(v => v.specVersion == specVersion)
        assert(d != null)
        ifs = new Interfaces(d.description)
        this.interfaces.set(specVersion, ifs)
        return ifs
    }
}


interface VersionDescription {
    specVersion: SpecVersion
    blockNumber: number
    types: Type[]
    events: eac.Registry
    calls: eac.Registry
    description: ChainDescription
}


interface Item {
    name: QualifiedName
    def: eac.Definition
    chain: VersionDescription
}
