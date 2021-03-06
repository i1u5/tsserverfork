import pump from 'pump'
import rangeParser from 'range-parser'
import { HttpError, HttpStatusCodes } from 'common-stuff'
import archiver from 'archiver'
import { Readable } from 'stream'

import { filterFiles } from '../services/torrent-client'
import { Globals } from '../config'
import { verifyJwtToken, getSteamUrl } from '../helpers'
import { createRoute, Route, getRouteUrl } from '../services/openapi'

export function getStreamRouter(
    { config, client }: Globals,
): Route[] {
    const encodeToken = config.security.streamApi.key || config.security.apiKey

    type Params = {
        torrent: string
        file?: string
        fileType?: string
        fileIndex?: number
        output?: string
    }
    const parseParams = (params: Params): Params => {
        if (encodeToken) {
            if (
                params.file ||
                params.fileIndex ||
                params.fileType ||
                params.output
            ) {
                throw new HttpError(
                    HttpStatusCodes.BAD_REQUEST,
                    `All parameters should be encoded with JWT`
                )
            }

            const data = verifyJwtToken<Params>(
                params.torrent,
                encodeToken,
                config.security.streamApi.maxAge
            )

            if (!data) {
                throw new HttpError(
                    HttpStatusCodes.FORBIDDEN,
                    'Incorrect JWT encofding'
                )
            }

            return data
        }

        return params
    }

    return [
        createRoute('getStream', async (req, res) => {
            const {
                torrent: link,
                output,
                ...params
            } = parseParams({
                torrent: req.params.torrent,
                ...req.query,
            })

            if (typeof req.socket.setTimeout === 'function') {
                req.socket.setTimeout(2 * 60 * 60 * 10)
            }

            const torrent = await client.addTorrent(link)
            const files = filterFiles(torrent.files, params)
            const file = files[0]
            const fileName =
                file && files.length === 1 ? file.name : torrent.name

            if (output === 'zip') {
                res.attachment(`${fileName}.zip`)

                const archive = archiver('zip')

                files.forEach((file) => {
                    archive.append(file.createReadStream() as Readable, {
                        name: file.path,
                    })
                })

                archive.finalize()

                return pump(archive, res, () => {
                    files.forEach((file) => {
                        file.stop()
                    })
                })
            }

            if (!file) {
                throw new HttpError(HttpStatusCodes.NOT_FOUND)
            }

            res.attachment(fileName)
            res.setHeader('Accept-Ranges', 'bytes')

            const parsedRange = req.headers.range
                ? rangeParser(file.length, req.headers.range)
                : undefined
            const range =
                parsedRange instanceof Array ? parsedRange[0] : undefined

            if (range) {
                res.statusCode = 206
                res.setHeader('Content-Length', range.end - range.start + 1)
                res.setHeader(
                    'Content-Range',
                    'bytes ' + range.start + '-' + range.end + '/' + file.length
                )
            } else {
                res.setHeader('Content-Length', file.length)
            }

            if (req.method === 'HEAD') {
                return res.end()
            }

            return pump(file.createReadStream(range), res, () => {
                file.stop()
            })
        }),
        createRoute('getStream2', async (req, res) => {
            const { torrent, ...query } = req.query

            return res.redirect(
                getRouteUrl('getStream', { torrent }, query),
                301
            )
        }),
        createRoute('getPlaylist', async (req, res) => {
            const domain = req.protocol + '://' + req.get('host')
            const { torrent: link, ...params } = parseParams({
                torrent: req.params.torrent,
                ...req.query,
            })

            const torrent = await client.addTorrent(link)
            const files = filterFiles(torrent.files, params).filter(
                (v) => v.type.includes('video') || v.type.includes('audio')
            )
            
            if (typeof req.socket.setTimeout === 'function') {
                req.socket.setTimeout(2 * 60 * 60 * 10)
            }

            res.attachment(torrent.name + `.m3u`)

            return res.send(
                [
                    '#EXTM3U',
                    ...files.flatMap((f) => [
                        `#EXTINF:-1,${f.name}`,
                        `${domain}${getSteamUrl(link, f.path, encodeToken)}`,
                    ]),
                ].join('\n')
            )
        }),
        createRoute('getPlaylist2', async (req, res) => {
            const { torrent, ...query } = req.query

            return res.redirect(
                getRouteUrl('getPlaylist', { torrent }, query),
                301
            )
        }),
    ]
}
