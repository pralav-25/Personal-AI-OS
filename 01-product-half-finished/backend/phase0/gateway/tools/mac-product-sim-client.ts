/** Simulated paired phone for end-to-end verification through the public origin. It builds every request body
 * itself from the pairing file and the bootstrap response (the same rules the iPhone client follows), opens the
 * E2EE key envelope with its own X25519 key, and prints statuses only — never tokens or key material.
 *
 *   node tools/mac-product-sim-client.ts --pairing <pairing file> --recipient-key <private JWK file> [--origin <url>] [--prompt TEXT] [--text-only] [--call] [--confirmation approve|deny] [--control <JSON file>] [--control-on-approval <JSON file>]
 *   Add --desktop <scratch> [--enrollment <phone-issued JSON file>] [--desktop-seconds 300] for a bounded Mac test host.
 *   Add --desktop-attachment <scratch file> [--desktop-via drag|paste] [--desktop-grant-seconds 86400]
 *   [--desktop-revoke-after 60] to rehearse a temporary grant; see docs/desktop-simulator.md.
 *   Desktop PDF extraction requires an existing pdftotext executable; image/Word extraction is outside this synthetic host.
 *   Add --origin-state <file> for the owner origin migration rehearsal; --origin-connect <file> maps its TLS connections to isolated loopback fronts.
 */
import { generateKeyPairSync, randomUUID, randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AudioStream, DataPacketKind, RoomEvent, TrackKind, dispose, AudioSource, AudioFrame, LocalAudioTrack, TrackSource, TrackPublishOptions } from '@livekit/rtc-node';
import { Ajv, type AnySchema } from 'ajv';
import addFormats from 'ajv-formats';
import { inspectWav, wavSamples } from '../../../services/personal-aios-integration/src/tts.ts';
import { consumeBoundedByteStream, createGatewayRoom } from '../src/sdk-room.ts';
import { LIVEKIT_KEY_PROVIDER_DEFAULTS } from '../src/realtime-public-control-persistent-e2ee-owner.ts';
import { createFormalWireAjv } from '../src/personal-aios-formal-text.ts';
import { createRequire } from 'node:module';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import {promises as fs,constants as fsConstants} from 'node:fs';
import {resolve,relative,dirname,basename,join,extname,isAbsolute,matchesGlob} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { canonical, digest, validateAttachments, type FileAttachment } from '../../../services/personal-aios-integration/src/contracts.ts';
import {createNonProductionUuidV7Generator} from '../../../services/memory-os/src/canonical-issuer.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import { realtimeE2eeRecipientBinding } from '../src/realtime-e2ee-ciphertext-resolver.ts';
import { SimOriginMigration } from './sim-origin-migration.ts';

type Json = Record<string, any>;
const require = createRequire(import.meta.url);
const { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } = require('@hpke/core') as any;
const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
/** Validate the same wire output boundary used by both simulator receive channels. */
export function validateSimulatorOutput(packet:Json,continuity:string,validators:Record<string,(packet:unknown)=>unknown>):Json {
  // Activity cards retain the owner's task session when replayed to a new terminal connection.
  if(!validators[packet.operation]?.(packet)||(packet.operation!=='activity_update'&&packet.session_id!==continuity))throw new Error('SIM_ACCEPTANCE_FAILED');
  return packet;
}
/** Opt-in effect regression: a fresh correlated errand report owns a separate event. */
export async function regressionErrandHeader(packets:Json[],token:string,device:string,sourceEvent:string,
  read:(id:string)=>Promise<{d:Json;session_id:string}>):Promise<Json|undefined> {
  const source=packets.findIndex(p=>p.operation==='accepted'&&p.event_id===sourceEvent);
  if(source<0)return;
  const original=await read(packets[source]!.processed_event_id);
  if(original.d.processed_event_id!==packets[source]!.processed_event_id||original.d.event_id!==sourceEvent||original.d.device_id!==device||original.d.origin!=='explicit_user_prompt'||!original.d.content.text.includes(token))return;
  for(const h of packets){
    const job=h.event_id?.match(/^errand:(job-[a-zA-Z0-9-]+)$/)?.[1];
    if(h.operation!=='result_header'||!job||h.reply_mode!=='text')continue;
    if(!packets.some((a,i)=>i>source&&a.operation==='accepted'&&a.event_id===h.event_id&&a.processed_event_id===h.processed_event_id&&a.admission?.run_id===h.run_id))continue;
    const bound=await read(h.processed_event_id),d=bound.d,result=d.content.app_event;
    if(d.processed_event_id===h.processed_event_id&&d.principal_id===original.d.principal_id&&d.device_id===device&&bound.session_id===original.session_id&&
      d.event_id===h.event_id&&result?.kind==='errand_result'&&result.job_id===job&&result.task.includes(token)&&
      result.success===true&&result.terminal_reason==='completed')return h;
  }
}
export function regressionRenderedAck(packets:Json[],d:string,ack:Json):boolean {
  return packets.some(p=>p.operation==='ack_receipt'&&p.processed_event_id===d&&ack.status==='rendered'&&
    Object.entries(ack).every(([key,value])=>p.receipt[key]===value));
}
/** Publish one recorded utterance and wait for its completed reply before the caller may hang up. */
export async function playRecordedCallSpeech(wav:Uint8Array,mic:Pick<AudioSource,'captureFrame'|'waitForPlayout'>,
  reply:{inputEnded:()=>void;complete:()=>Promise<void>;audibleSamples:()=>number;check:()=>void},
  clock:{now:()=>number;wait:(ms:number)=>Promise<void>}={now:()=>performance.now(),wait:sleep}){
  const audio=inspectWav(wav),pcm=wavSamples(wav);
  if(audio.sample_rate!==16000||audio.channels!==1)throw new Error('SIM_SPEECH_FORMAT_INVALID');
  const began=clock.now();
  for(let at=0;at<pcm.length;at+=320){const frame=pcm.slice(at,at+320);await mic.captureFrame(new AudioFrame(frame,16000,1,frame.length));await clock.wait(Math.max(0,began+(at+frame.length)/16-clock.now()));}
  await mic.waitForPlayout();reply.inputEnded();
  for(let n=0;n<75;n++){await mic.captureFrame(new AudioFrame(new Int16Array(320),16000,1,320));await clock.wait(20);}
  await reply.complete();
  const deadline=clock.now()+30000;let previous=-1;
  while(previous!==reply.audibleSamples()){
    if(clock.now()>deadline)throw new Error('SIM_REPLY_PLAYOUT_TIMEOUT');
    previous=reply.audibleSamples();await clock.wait(1500);reply.check();
  }
  return pcm.length;
}
/** Synthetic scratch host only; it deliberately has no access to product folders or native app control. */
export async function createDesktopSimulator(scratch:string,room:ReturnType<typeof createGatewayRoom>,gateway:string,report:(event:Json)=>void=event=>process.stdout.write(JSON.stringify({...event,at_ms:Date.now()})+'\n'),options:{folders?:string[];now?:()=>number}={}){
  const {Server}=await import('@modelcontextprotocol/sdk/server/index.js');
  const {CallToolRequestSchema,ListToolsRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
  const uuids=createNonProductionUuidV7Generator({nowMs:Date.now,randomBytes});
  const root=await fs.realpath(scratch);if(root==='/'||root===process.env.HOME)throw new Error('GUARD_PATH_NOT_AUTHORIZED');
  const now=options.now??Date.now,folders=[...(options.folders??[join(root,'文稿','依米')])],grants=new Map<string,{attachment:FileAttachment;expires:number;dev:number;ino:number}>(),initialized=Promise.withResolvers<void>();
  const manifest=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/desktop-tools.v1.json',import.meta.url),'utf8')) as Json;
  const ajv=new Ajv({strict:false});addFormats.default(ajv);const validators=new Map(manifest.tools.map((tool:Json)=>[tool.name,ajv.compile(tool.inputSchema)]));
  const fail=(code:string):never=>{throw new Error(code);},inside=(path:string)=>{const tail=relative(root,path);return tail===''||!tail.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&tail!=='..'&&!isAbsolute(tail);};
  const scoped=async(value:unknown,tool?:string):Promise<string>=>{
    if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0')||Buffer.byteLength(value)>1024||value.split('/').includes('..'))return fail('GUARD_PATH_INVALID');
    let parent=resolve(value);const tail:string[]=[];
    while(true){try{parent=await fs.realpath(parent);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;tail.unshift(basename(parent));parent=dirname(parent);}}
    const path=join(parent,...tail);if(!inside(path))return fail('GUARD_PATH_NOT_AUTHORIZED');
    if(relative(root,path).split('/').some(part=>/^\.(ssh|gnupg|aws|kube|trash|undo|incoming)$/i.test(part)||/keychains/i.test(part)||/^(\.env|\.netrc|id_rsa.*|id_ed25519.*)$/i.test(part)||/\.(pem|key|p12|pfx|keychain-db)$/i.test(part)))return fail('GUARD_SENSITIVE_PATH');
    if(tool&&!folders.some(folder=>path===folder||path.startsWith(folder+'/'))){
      const grant=[...grants.values()].find(item=>item.attachment.path===path&&item.expires>now());
      if(!grant||!['read_text_file','get_file_info','extract_text','upload_to_workshop','write_file','edit_file','trash'].includes(tool))return fail('GUARD_PATH_NOT_AUTHORIZED');
      const info=await fs.stat(path);if(info.dev!==grant.dev||info.ino!==grant.ino||!info.isFile()||info.nlink!==1)return fail('GUARD_PATH_NOT_AUTHORIZED');
    }
    return path;
  };
  for(let i=0;i<folders.length;i++)folders[i]=await scoped(folders[i]);
  const grant=async(value:string,via:'drag'|'paste',ttlSeconds=86400)=>{
    if(!['drag','paste'].includes(via)||!Number.isFinite(ttlSeconds)||ttlSeconds<=0)fail('SIM_GRANT_INVALID');
    const path=await scoped(value),info=await fs.stat(path);if(!info.isFile()||info.nlink!==1)fail('GUARD_PATH_NOT_AUTHORIZED');
    const id=uuids.issue(),attachment:FileAttachment={grant_id:id,path,name:basename(path),size:info.size,kind:kind(path) as FileAttachment['kind']};validateAttachments([attachment]);
    const at=now(),expires=at+ttlSeconds*1000;grants.set(id,{attachment,expires,dev:info.dev,ino:info.ino});report({step:'desktop_grant',status:'granted',grant_id:id,via});
    // GuardPolicy uses JSONEncoder's default Date encoding: seconds since 2001-01-01 UTC.
    return {attachment,record:{id,path,name:attachment.name,size:info.size,kind:attachment.kind,via,dev:info.dev,ino:info.ino,granted_at:(at-Date.UTC(2001,0,1))/1000,expires_at:(expires-Date.UTC(2001,0,1))/1000}};
  };
  const hashFile=async(path:string,signal:AbortSignal)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal.throwIfAborted();hash.update(chunk);}return hash.digest('hex');};
  const backup=async(path:string)=>{try{await fs.access(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}const folder=join(root,'.undo',randomUUID());await fs.mkdir(folder,{recursive:true});await fs.copyFile(path,join(folder,basename(path)),fsConstants.COPYFILE_EXCL);};
  const send=async(topic:string,mimeType:string,attributes:Record<string,string>,size:number,chunks:AsyncIterable<Uint8Array>)=>{
    const writer=await room.localParticipant!.streamBytes({topic,mimeType,attributes,totalSize:size,destinationIdentities:[gateway]});
    try{for await(const bytes of chunks)for(let offset=0;offset<bytes.length;offset+=65536)await writer.write(bytes.subarray(offset,offset+65536));}finally{await writer.close();}
  };
  const transport:{start:()=>Promise<void>;close:()=>Promise<void>;send:(message:Json)=>Promise<void>;onmessage?:(message:any)=>void;onerror?:(error:Error)=>void;onclose?:()=>void}={
    start:async()=>{},close:async()=>{transport.onclose?.();},send:async message=>{const bytes=Buffer.from(JSON.stringify(message));if(bytes.length>1048576)fail('DESKTOP_FRAME_TOO_LARGE');await send('paios.desktop.mcp.v1','application/json',{v:'1'},bytes.length,(async function*(){yield bytes;})());}};
  const server=new Server({name:'paios-sim-desktop',version:'1'},{capabilities:{tools:{listChanged:false}}});
  let current=true,paused=false,consent=false,writes=Promise.resolve(),inflight=0;
  const active=new Map<string,AbortController>(),downloads=new Map<string,ReturnType<typeof Promise.withResolvers<Json>>>(),readers=new Set<ReturnType<typeof consumeBoundedByteStream>>();
  const receive=(reader:any,sender:{identity:string},maxBytes:number,write:(chunk:Uint8Array)=>Promise<void>|void,allowed=()=>true)=>{
    const task=consumeBoundedByteStream({room,reader,maxBytes,current:()=>current&&allowed(),authorize:async()=>{if(sender.identity!==gateway||reader.info.attributes?.v!=='1'||reader.info.mimeType!==(maxBytes===1048576?'application/json':'application/octet-stream'))fail('SIM_FRAME_DENIED');},write,error:()=>new Error('DESKTOP_FRAME_TOO_LARGE')});
    readers.add(task);void task.done.finally(()=>readers.delete(task)).catch(()=>{});return task;
  };
  room.registerByteStreamHandler('paios.desktop.mcp.v1',(reader,sender)=>{const chunks:Buffer[]=[];
    void receive(reader,sender,1048576,chunk=>{chunks.push(Buffer.from(chunk));}).done.then(async()=>{
      const message=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(message.method==='notifications/paios/pause'){if(typeof message.params?.paused!=='boolean')fail('SIM_FRAME_DENIED');paused=message.params.paused;if(paused)for(const pending of active.values())pending.abort(new Error('DESKTOP_PAUSED'));await server.notification({method:'notifications/paios/state',params:{paused}});}
      if(message.method==='tools/call'&&message.params?.name==='save_from_workshop'){const transfer=message.params.arguments?._transfer;if(transfer)downloads.set(transfer.transfer_id,Promise.withResolvers<Json>());}
      transport.onmessage?.(message);
    }).catch(error=>transport.onerror?.(error));});
  room.registerByteStreamHandler('paios.desktop.file.v1',(reader,sender)=>{const a=reader.info.attributes??{},pending=downloads.get(a.transfer??''),controller=active.get(a.request??'');
    void (async()=>{if(!current||sender.identity!==gateway||!pending||!controller||a.dir!=='down'||reader.info.mimeType!=='application/octet-stream'||!/^[0-9a-f]{64}$/.test(a.sha256??''))fail('TRANSFER_INTEGRITY');
      const folder=join(root,'.incoming');await fs.mkdir(folder,{recursive:true});const path=join(folder,randomUUID()),file=await fs.open(path,'wx',0o600),hash=createHash('sha256');let size=0;
      try{await receive(reader,sender,52428800,async chunk=>{size+=chunk.length;hash.update(chunk);await file.writeFile(chunk);},()=>!controller!.signal.aborted).done;
        if(size!==Number(a.size)||hash.digest('hex')!==a.sha256)fail('TRANSFER_INTEGRITY');pending!.resolve({path,size,sha256:a.sha256,request:a.request});
      }finally{await file.close();}
    })().catch(error=>pending?.reject(error));});
  const kind=(path:string)=>(({ '.pdf':'pdf','.png':'image','.jpg':'image','.jpeg':'image','.docx':'document','.rtf':'document','.xlsx':'spreadsheet','.csv':'spreadsheet','.pptx':'presentation','.txt':'text','.md':'text','.json':'text','.zip':'archive'} as Record<string,string>)[extname(path).toLowerCase()]??'other');
  const listing=async(folder:string,recursive=false):Promise<Json[]>=>{const out:Json[]=[];
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=await scoped(join(folder,entry.name),'list_directory'),info=await fs.stat(path);
      out.push({path,name:entry.name,size:info.size,modified:info.mtime.toISOString(),kind:kind(path),directory:info.isDirectory()});if(out.length>=500)break;
      if(recursive&&entry.isDirectory())out.push(...(await listing(path,true)).slice(0,500-out.length));}return out;};
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:manifest.tools}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    const tool=manifest.tools.find((tool:Json)=>tool.name===request.params.name),args=request.params.arguments??{},requestId=String(extra.requestId),abort=new AbortController();
    const cancel=()=>abort.abort(extra.signal.reason);extra.signal.addEventListener('abort',cancel,{once:true});active.set(requestId,abort);
    const run=async()=>{
      abort.signal.throwIfAborted();if(paused)fail('DESKTOP_PAUSED');const {_transfer,...publicArgs}=args as Json;if(!tool||!(validators.get(tool.name) as any)(publicArgs))fail('GUARD_TYPE_UNSUPPORTED');
      const a=args as Json,name=tool.name,path=a.path===undefined?undefined:await scoped(a.path,name);let result:unknown;
      if(name==='list_allowed_directories')result=folders.map(path=>({path,label:basename(path),write:true}));
      else if(name==='list_directory'||name==='list_directory_with_sizes')result=(await listing(path!)).sort((x,y)=>a.sortBy==='size'?y.size-x.size:x.name.localeCompare(y.name));
      else if(name==='find_files'||name==='search_files'){
        result=(await listing(await scoped(a.folder??a.path,name),true)).filter(item=>name==='search_files'?matchesGlob(item.path,a.pattern)&&!(a.excludePatterns??[]).some((pattern:string)=>matchesGlob(item.path,pattern)):
          (!a.query||item.name.toLowerCase().includes(a.query.toLowerCase()))&&(!a.kinds||a.kinds.includes(item.kind))&&(!a.modified_after||item.modified>=a.modified_after)&&(!a.modified_before||item.modified<=a.modified_before)).slice(0,a.limit??500);
      }else if(name==='get_file_info'){const info=await fs.stat(path!);result={size:info.size,created:info.birthtime.toISOString(),modified:info.mtime.toISOString(),isFile:info.isFile(),isDirectory:info.isDirectory()};}
      else if(name==='read_text_file'||name==='extract_text'){
        if((await fs.stat(path!)).size>262144)fail('GUARD_TOO_LARGE');let text:string;
        if(name==='extract_text'&&kind(path!)==='pdf'){
          try{text=(await promisify(execFile)('pdftotext',[...(a.pages?.length===1?['-f',String(a.pages[0]),'-l',String(a.pages[0])]:[]),path!,'-'],{maxBuffer:262144,signal:abort.signal})).stdout;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')fail('GUARD_TYPE_UNSUPPORTED');throw error;}
        }else{if(name==='extract_text'&&!['text','spreadsheet'].includes(kind(path!)))fail('GUARD_TYPE_UNSUPPORTED');text=await fs.readFile(path!,'utf8');}
        if(a.head!==undefined)text=text.split('\n').slice(0,a.head).join('\n');if(a.tail!==undefined)text=text.split('\n').slice(-a.tail).join('\n');result=text.slice(0,a.max_chars??262144);
      }else if(name==='create_directory'){await fs.mkdir(path!,{recursive:true});result={path};}
      else if(name==='write_file'||name==='edit_file'){
        let text=a.content;if(name==='edit_file'){text=await fs.readFile(path!,'utf8');for(const edit of a.edits){if(!text.includes(edit.oldText))fail('GUARD_NOT_FOUND');text=text.replace(edit.oldText,edit.newText);}}
        if(Buffer.byteLength(text)>262144)fail('GUARD_TOO_LARGE');if(!a.dryRun){await backup(path!);abort.signal.throwIfAborted();await fs.writeFile(path!,text);}result=a.dryRun?text:{path};
      }else if(name==='move_file'){const source=await scoped(a.source,name),destination=await scoped(a.destination,name);try{await fs.lstat(destination);fail('GUARD_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await fs.rename(source,destination);result={path:destination};}
      else if(name==='trash'){
        const paths=await Promise.all(a.paths.map((path:string)=>scoped(path,name)));if(!consent){const answer=await server.elicitInput({mode:'form',message:'允许把测试文件移到测试废纸篓吗？',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':extra.requestId}},{signal:abort.signal,relatedRequestId:extra.requestId});report({step:'desktop_elicitation',action:answer.action});if(answer.action!=='accept')fail('GUARD_CONSENT_DENIED');consent=true;}
        const folder=join(root,'.trash');await fs.mkdir(folder,{recursive:true});result=[];for(const source of paths){abort.signal.throwIfAborted();const destination=join(folder,randomUUID()+'-'+basename(source));await fs.rename(source,destination);(result as unknown[]).push({trash_path:destination});}
      }else if(name==='upload_to_workshop'){
        const info=await fs.stat(path!);if(!info.isFile()||info.nlink!==1)fail('GUARD_TYPE_UNSUPPORTED');if(info.size>26214400)fail('TRANSFER_TOO_LARGE');const transfer_id='dt-'+uuids.issue(),sha256=await hashFile(path!,abort.signal);
        await send('paios.desktop.file.v1','application/octet-stream',{v:'1',transfer:transfer_id,dir:'up',name:basename(path!),size:String(info.size),sha256,request:requestId},info.size,(async function*(){for await(const chunk of createReadStream(path!)){abort.signal.throwIfAborted();yield chunk;}})());result={transfer_id,size:info.size,sha256};
      }else if(name==='save_from_workshop'){
        const transfer=a._transfer;if(!transfer||!/^dt-[a-f0-9-]+$/.test(transfer.transfer_id))fail('TRANSFER_INTEGRITY');const incoming=downloads.get(transfer.transfer_id)!;if(!incoming)fail('TRANSFER_INTEGRITY');
        try{const file=await Promise.race([incoming.promise,new Promise<never>((_,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}))]);
          if(file.size!==transfer.size||file.sha256!==transfer.sha256||file.request!==requestId)fail('TRANSFER_INTEGRITY');const folder=await scoped(a.folder??folders[0],name),destination=await scoped(join(folder,a.name??basename(a.workshop_path)),name);await backup(destination);abort.signal.throwIfAborted();await fs.rename(file.path,destination);result={path:destination,size:file.size,sha256:file.sha256};
        }finally{downloads.delete(transfer.transfer_id);}
      }
      abort.signal.throwIfAborted();const text=typeof result==='string'?result:JSON.stringify(result);if(Buffer.byteLength(text)>262144)fail('GUARD_TOO_LARGE');report({step:'desktop_tool',tool:name,outcome:'ok',...(name==='upload_to_workshop'?{transfer_id:(result as Json).transfer_id}:{})});return {content:[{type:'text' as const,text}],...(typeof result==='object'&&!Array.isArray(result)?{structuredContent:result as Record<string,unknown>}:{})};
    };
    inflight++;try{if(inflight>4)fail('DESKTOP_BUSY');if(tool?.['x-paios'].class==='read')return await run();const previous=writes;const done=Promise.withResolvers<void>();writes=done.promise;try{await previous;return await run();}finally{done.resolve();}}
    catch(error){const code=abort.signal.aborted?(paused?'DESKTOP_PAUSED':'DESKTOP_CANCELLED'):error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SIM_TOOL_FAILED';report({step:'desktop_tool',tool:tool?.name??'unknown',outcome:'error',error_code:code});return {isError:true,content:[{type:'text' as const,text:code}],structuredContent:{error:{code,retryable:false}}};}
    finally{inflight--;active.delete(requestId);extra.signal.removeEventListener('abort',cancel);}
  });
  server.oninitialized=()=>{initialized.resolve();void server.notification({method:'notifications/paios/state',params:{paused}}).catch(error=>transport.onerror?.(error));};
  await server.connect(transport);
  return {grant,ready:initialized.promise,revoke:(id:string)=>{if(!grants.delete(id))fail('GUARD_NOT_FOUND');report({step:'desktop_grant',status:'revoked',grant_id:id});},close:async()=>{current=false;grants.clear();for(const abort of active.values())abort.abort();for(const reader of readers)reader.cancel();await server.close();room.unregisterByteStreamHandler('paios.desktop.mcp.v1');room.unregisterByteStreamHandler('paios.desktop.file.v1');}};
}

export function regressionFailureBinding(eventId:string, packets:Json[]):Json {
  const accepted=packets.find(packet=>packet.operation==='accepted'&&packet.event_id===eventId);
  const header=packets.filter(packet=>packet.operation==='result_header'&&packet.event_id===eventId).at(-1);
  return {event_id:eventId,processed_event_id:accepted?.processed_event_id ?? null,
    run_id:header?.run_id ?? accepted?.admission?.run_id ?? null};
}

async function main(){
const desktop=argument('--desktop'),enrollmentPath=argument('--enrollment');
const textOnly=process.argv.includes('--text-only');
if(textOnly&&(process.argv.includes('--call')||argument('--speech')))throw new Error('SIM_TEXT_ONLY_AUDIO_CONFLICT');
if(argument('--desktop-attachment')&&!desktop)throw new Error('SIM_DESKTOP_REQUIRED');
if(enrollmentPath){
  if(!desktop)throw new Error('SIM_DESKTOP_REQUIRED');
  const enrollment=JSON.parse(readFileSync(enrollmentPath,'utf8')) as Json;
  if(enrollment.schema!=='paios.mac-enrollment.v1'||!Number.isFinite(Date.parse(enrollment.expires_at))||Date.parse(enrollment.expires_at)<=Date.now()||!/^https:\/\//.test(enrollment.origin)||new URL(enrollment.origin).origin!==enrollment.origin||!/^[A-Za-z0-9_-]{43}$/.test(enrollment.token))throw new Error('MAC_ENROLLMENT_INVALID');
  const keys=generateKeyPairSync('x25519'),recipient=keys.privateKey.export({format:'jwk'}),publicKey=keys.publicKey.export({format:'jwk'}).x!;
  const response=await fetch(`${enrollment.origin}/v1/devices/mac/enrollment/exchange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:enrollment.token,registration:{device_type:'mac',public_raw32_base64url:publicKey,public_sha256:createHash('sha256').update(Buffer.from(publicKey,'base64url')).digest('hex'),capabilities:['display','speaker','microphone','notifications','chat_ui','desktop_tools'],label:'Desktop test terminal'}})});
  if(!response.ok)throw new Error('SIM_MAC_ENROLLMENT_FAILED');
  writeFileSync(argument('--recipient-key')!,JSON.stringify(recipient),{mode:0o600,flag:'wx'});
  writeFileSync(argument('--pairing')!,JSON.stringify(await response.json()),{mode:0o600,flag:'wx'});
}
const pairing = JSON.parse(readFileSync(argument('--pairing')!, 'utf8')) as Json;
const recipientJwk = JSON.parse(readFileSync(argument('--recipient-key')!, 'utf8')) as Json;
const origin = argument('--origin') ?? pairing.origin;
const migration = argument('--origin-state') ? new SimOriginMigration(pairing, argument('--origin-state')!, argument('--origin-connect')) : undefined;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = createProductionRealtimeIdentityPort({ clock: { now: () => assertCanonicalTimestamp(new Date().toISOString()) } });
const uuid = (purpose: string) => identity.createConnectionId({ deviceId: pairing.device_id, requestId: `${purpose}.${Date.now()}` });

const OPERATION_KIND: Json = { bootstrap: 'realtime_bootstrap', realtime_e2ee_key_resolve: 'realtime_e2ee_key_resolve',
  connected_credential_refresh: 'realtime_credential_refresh', media_stop: 'realtime_media_stop', end_continuity: 'realtime_end_continuity' };
const PROFILE_SLUG: Json = { bootstrap: 'bootstrap', realtime_e2ee_key_resolve: 'e2ee-key-resolve',
  connected_credential_refresh: 'credential-refresh', media_stop: 'media-stop', end_continuity: 'end-continuity' };
// Device-side idempotency context: the request hash is over the body without the context; the server stores and
// compares the whole context for replay and binds it into the E2EE AAD.
function withContext(body: Json, target?: Json): Json {
  const operation = body.operation as string;
  const profileId = `https://personal-ai-os.local/contracts/realtime/idempotency/${PROFILE_SLUG[operation]}`;
  return { ...body, idempotency_context: {
    idempotency_scope: { owner_module: 'T11B', operation_kind: OPERATION_KIND[operation],
      target_object_type: operation === 'media_stop' ? 'DeviceLease' : 'RealtimeSession',
      ...(target ? { target_object_id: target.ref_id } : {}), user_id: pairing.user_id },
    idempotency_key: body.request_id, idempotency_profile_id: profileId, idempotency_profile_version: '1.0.0',
    idempotency_profile_sha256: sha256(canonical({ profile_id: profileId, profile_version: '1.0.0', hash_algorithm: 'sha256_rfc8785_jcs' })),
    idempotency_request_sha256: sha256(canonical(body)) } };
}
const safeErrorCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value);
async function post(path: string, body: Json): Promise<{ status: number; body: Json; diagnostic?: Json }> {
  const response = migration ? await migration.post(path, body) : await fetch(`${origin}${path}`, { method: 'POST', redirect: 'error', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' } });
  const text = await response.text();
  let parsed: Json; try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
  return { status: response.status, body: parsed, ...(!response.ok ? { diagnostic: {
    ...(mime && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime) ? { content_type: mime } : {}),
    body_fields: parsed && typeof parsed === 'object' ? Object.keys(parsed).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 40) : [],
    error_codes: [parsed?.code, parsed?.error_code, parsed?.error?.code, parsed?.error?.error_code].filter(safeErrorCode) } } : {}) };
}
const summary = (body: Json) => ({ status: body.status, error: body.error?.error_code ?? body.error_code, outcome: body.outcome });
const steps: Json[] = [];
const regressionEvidence = process.argv.includes('--regression-evidence');
if(regressionEvidence && process.env.PAIOS_STAGE!=='staging')throw new Error('SIM_STAGING_REQUIRED');
const record = (step: string, result: { status: number; body: Json; diagnostic?: Json }, extra: Json = {}) => {
  steps.push({ step, http: result.status, ...(result.diagnostic ?? summary(result.body)), ...extra }); return result;
};
const requireFact = (condition: unknown) => { if (!condition) throw new Error('SIM_ACCEPTANCE_FAILED'); };

const startedAt = new Date().toISOString();
const bootstrapBody = withContext({ operation: 'bootstrap', bootstrap_mode: 'initial', request_id: uuid('bootstrap'), device_id: pairing.device_id,
  start: { kind: 'explicit_user_start', device_id: pairing.device_id, modalities: textOnly ? ['data'] : ['audio', 'data'], started_at: startedAt },
  requested_media: { audio: !textOnly, video: false, data: true }, governance: pairing.governance });
const boot = record('bootstrap', await post('/v1/realtime/bootstrap', bootstrapBody));
if (boot.status !== 200) { process.stdout.write(JSON.stringify({ steps }) + '\n'); process.exit(1); }
const b = boot.body;
if (migration) await migration.bootstrap(b, bootstrapBody);
const replay = await post('/v1/realtime/bootstrap', bootstrapBody);
record('bootstrap_replay', replay, { identical: canonical(replay.body) === canonical(b) });
// Crash recovery: the committed read fact alone must let the device stop what this bootstrap started.
const fact = await post('/v1/realtime/bootstrap/reconcile', bootstrapBody);
record('bootstrap_reconcile', fact, { committed: fact.body.status === 'committed',
  binding: ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'transport_aliases',
    'e2ee_key_envelope', 'recipient_device_credential_ref'].every(key => canonical(fact.body[key]) === canonical(b[key])) });

const common = { realtime_session_ref: b.realtime_session_ref, device_lease_ref: b.device_lease_ref, continuity_id: b.continuity_id,
  connection_epoch: b.connection_epoch, transport_aliases: b.transport_aliases, governance: pairing.governance };
const participant = (b.transport_aliases as Json[]).find(alias => alias.alias_type === 'participant');
const envelope = b.e2ee_key_envelope;
const resolveBody = withContext({ operation: 'realtime_e2ee_key_resolve', request_id: uuid('e2ee'), ...common,
  key_envelope_ref: envelope.key_envelope_ref, key_index: envelope.key_index, key_generation: envelope.key_generation,
  device_id: pairing.device_id, recipient_device_credential_ref: b.recipient_device_credential_ref, participant_audience: participant },
  b.realtime_session_ref);
const resolved = await post('/v1/realtime/e2ee/key/resolve', resolveBody);
let opened: Json = {}, contentKey: Uint8Array | undefined;
if (resolved.status === 200) {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const recipientKey = await suite.kem.deserializePrivateKey(new Uint8Array(Buffer.from(recipientJwk.d, 'base64url')));
  // Bind exactly the request that went on the wire (parsed JSON, no shared object references).
  const { info, aad } = realtimeE2eeRecipientBinding(JSON.parse(JSON.stringify(resolveBody)), resolved.body.expires_at);
  const plaintext = Buffer.from(await suite.open({ recipientKey, enc: Buffer.from(resolved.body.encapsulated_key, 'base64url'), info },
    Buffer.from(resolved.body.ciphertext, 'base64url'), aad));
  let offset = 10;
  requireFact(plaintext.subarray(0, 8).toString('ascii') === 'PAIOSKEY' && plaintext.readUInt16BE(8) === 1);
  for (const expected of [String(envelope.key_index), String(envelope.key_generation)]) {
    const length = plaintext.readUInt16BE(offset); offset += 2;
    requireFact(plaintext.subarray(offset, offset + length).toString('utf8') === expected); offset += length;
  }
  opened = { opened: true, content_key_bytes: plaintext.length - offset };
  if (opened.content_key_bytes === 32) contentKey = plaintext.subarray(-32);
}
record('e2ee_key_resolve', resolved, opened);

const errandToken=argument('--regression-errand-token');
if(errandToken)requireFact(regressionEvidence&&/^regression-[a-f0-9]{32}$/.test(errandToken));
const errandStore=errandToken?await (async()=>{
  const {loadHostConfiguration}=await import('../../../services/personal-aios-integration/src/host-configuration.ts');
  const {PosixStorage}=await import('../../../services/personal-aios-integration/src/storage.ts');
  return new PosixStorage((await loadHostConfiguration('/etc/paios/cloud.json')).storage_root,{read_only:true});
})():undefined;
const readErrand=async(id:string):Promise<{d:Json;session_id:string}>=>{
  const decode=(bytes:Uint8Array)=>JSON.parse(Buffer.from(bytes).toString());
  const key=digest({principal_id:pairing.user_id,processed_event_id:id});
  return {d:decode(await errandStore!.read('processed-events',key)),session_id:decode(await errandStore!.read('d-session-bindings',key)).session_id};
};
const attachmentPath=argument('--desktop-attachment'),promptText=argument('--prompt')??(attachmentPath?'这是合成验收附件。请仅用文字登记文件，等待手机发起读取和上传请求。':undefined);
let playbackFailed = false;
if (desktop || promptText !== undefined || process.argv.includes('--call') || argument('--control')) {
  const room = createGatewayRoom(), readers: ReadableStreamDefaultReader[] = [], receiving: Promise<void>[] = [];
  if(desktop)requireFact(pairing.device_type==='mac'&&contentKey);
  const host=desktop?await createDesktopSimulator(desktop,room,b.central_text_transport.expected_gateway_identity):undefined,stop=Promise.withResolvers<void>();
  let grant:Awaited<ReturnType<NonNullable<typeof host>['grant']>>|undefined,timeout:ReturnType<typeof setTimeout>|undefined,revokeTimer:ReturnType<typeof setTimeout>|undefined,hostReady=false;
  void host?.ready.then(()=>{hostReady=true;});const quit=()=>stop.resolve();
  if(host){process.once('SIGINT',quit);process.once('SIGTERM',quit);room.on(RoomEvent.Disconnected,quit);room.on(RoomEvent.ParticipantDisconnected,peer=>{if(peer.identity===b.central_text_transport.expected_gateway_identity)quit();});}
  const mic=argument('--speech')?new AudioSource(16000,1,100):undefined;
  const micTrack=mic?LocalAudioTrack.createAudioTrack('staging-recorded-speech',mic):undefined;
  let speechEnded=false,replySamples=0,replyLoud=0;
  const packets: Json[] = []; let failure: unknown, gatewayReady = false, play = Promise.resolve(), played = 0, duration = 0, bytes = 0, samples = 0, loud = 0;
  let stage = 'room_join', failureStage: string | undefined;
  const renderQueued=new Set<Json>();
  let render = Promise.resolve(), rendered = 0, expectedVoice: number | undefined, voiceOutputId: string | undefined, readyHeader: Json | undefined;
  let callId: string | undefined, before = 0, beforeSamples = 0, attempts = 0;
  const wire = JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json', import.meta.url), 'utf8')) as Json;
  const ajv = createFormalWireAjv();
  const extension=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/terminal-message.v1.json',import.meta.url),'utf8')) as Json;
  const validators = Object.fromEntries(Object.entries(wire.outputs).map(([name, definition]) =>
    [name, ajv.compile({ $defs: wire.$defs, ...(definition as AnySchema as object) })]));
  // A paired phone receives every registered extension's outputs, each pinned by the formal registry.
  for(const {contract,sha256:pinned} of wire.extensions as {contract:string;sha256:string}[]){
    const bytes=readFileSync(new URL(`../../../../../integrations/contracts/${contract}`,import.meta.url));
    requireFact(createHash('sha256').update(bytes).digest('hex')===pinned);const added=JSON.parse(bytes.toString('utf8')) as Json;
    for(const [name,definition] of Object.entries(added.outputs))validators[name]=ajv.compile({$defs:added.$defs,...(definition as object)});
  }
  const valid = (packet: Json) => validateSimulatorOutput(packet,b.continuity_id,validators);
  const send = (packet: Json) => { requireFact(gatewayReady); return room.localParticipant!.publishData(Buffer.from(JSON.stringify(packet)), { reliable: true,
    destination_identities: [b.central_text_transport.expected_gateway_identity], topic: wire.input_topic }); };
  const until = async (ready: () => boolean, retry?: () => Promise<void>, timeout = 300000) => { const deadline = Date.now() + timeout; let next = Date.now() + 2000;
    while (!ready()) { if (failure) throw failure; if (Date.now() > deadline) throw new Error('SIM_RECEIPT_TIMEOUT');
      if (retry && Date.now() >= next) { await retry(); next = Date.now() + 2000; } await sleep(100); } if (failure) throw failure; };
  const control=async(path:string)=>{const body=JSON.parse(readFileSync(path,'utf8'));requireFact(extension.inputs[body.operation]&&ajv.compile({$defs:extension.$defs,...extension.inputs[body.operation].definition})(body));
    steps.push({step:'terminal_control_sent',operation:body.operation,control_id:body.control_id,at_ms:Date.now()});await send(body);
    await until(()=>packets.some(packet=>packet.operation==='terminal_receipt'&&packet.control_id===body.control_id));const receipt=packets.find(packet=>packet.operation==='terminal_receipt'&&packet.control_id===body.control_id)!;
    requireFact(receipt.ok);steps.push({step:'terminal_control',operation:body.operation,ok:receipt.ok,at_ms:Date.now()});};
  // LK-2 sends ready as a text stream: its sender is server-stamped even before the
  // gateway announcement reaches this client. Every other output remains a data packet.
  room.registerTextStreamHandler(wire.output_topic, (reader, sender) => {
    receiving.push((async () => {
      requireFact(sender.identity === b.central_text_transport.expected_gateway_identity);
      let text = '';
      for await (const chunk of reader) {
        text += chunk; requireFact(Buffer.byteLength(text) <= b.central_text_transport.max_packet_bytes);
      }
      const packet = valid(JSON.parse(text)); requireFact(packet.operation === 'ready');
      gatewayReady = true;
    })().catch(error => { failure = error; }));
  });
  room.on(RoomEvent.DataReceived, async (data, sender, kind, topic) => {
    if (topic !== wire.output_topic || sender?.identity !== b.central_text_transport.expected_gateway_identity) return;
    try { requireFact(kind === DataPacketKind.KIND_RELIABLE && data.byteLength <= b.central_text_transport.max_packet_bytes);
      const packet = valid(JSON.parse(Buffer.from(data).toString())); requireFact(packet.operation !== 'ready'); packets.push(packet);
      if(packet.operation==='voice_confirmations'&&argument('--confirmation')){const choice=argument('--confirmation');requireFact(choice==='approve'||choice==='deny');
        for(const item of packet.confirmations)if(item.kind==='native_approval'&&!steps.some(step=>step.confirmation_id===item.confirmation_id)){steps.push({step:'native_approval',choice,confirmation_id:item.confirmation_id});void (async()=>{if(argument('--control-on-approval'))await control(argument('--control-on-approval')!);await send({operation:'voice_confirm',confirmation_id:item.confirmation_id,choice});})().catch(error=>{failure=error;});}
        // A dial call's unverified speech: the owner's phone answers after Face ID with the biometric only, no choice.
        for(const item of packet.confirmations)if(choice==='approve'&&item.purpose==='call'&&!steps.some(step=>step.confirmation_id===item.confirmation_id)){
          steps.push({step:'call_confirmation',confirmation_id:item.confirmation_id});void send({operation:'voice_confirm',confirmation_id:item.confirmation_id,auth:'face_id'}).catch(error=>{failure=error;});}}
      if (packet.operation === 'rejected' || packet.operation === 'call_state' && packet.state === 'failed') throw new Error('SIM_GATEWAY_REJECTED');
      if(errandToken&&!readyHeader&&packet.operation==='result_header'&&packet.event_id.startsWith('errand:')){readyHeader=await regressionErrandHeader(packets,errandToken,pairing.device_id,eventId,readErrand);if(readyHeader)expectedVoice=0;}
      const selectedEvent=readyHeader?.event_id??eventId;
      const accepted = packets.find(p => p.operation === 'accepted' && p.event_id === (errandToken?selectedEvent:eventId));
      if (packet.operation === 'result_header' && packet.event_id === eventId && !errandToken && (packet.voice_status === 'ready' || packet.reply_mode === 'text')) {
        requireFact(accepted && packet.processed_event_id === accepted.processed_event_id);
        const persisted = packets.filter(p => p.operation === 'ack_receipt' && p.processed_event_id === packet.processed_event_id &&
          p.receipt.output_id === voiceOutputId && p.receipt.reply_id === packet.reply_id && p.receipt.reply_epoch === packet.reply_epoch &&
          p.receipt.target_device_id === pairing.device_id && p.receipt.status === 'played');
        const total = packet.pending_voice_chunk_count + Math.max(0, ...persisted.map(p => p.receipt.highest_contiguous_seq));
        requireFact(expectedVoice === undefined || expectedVoice === total); expectedVoice = total; readyHeader = packet;
      }
      const pendingText=errandToken?packets.filter(p=>readyHeader&&p.operation==='text_chunk'&&p.processed_event_id===readyHeader.processed_event_id&&!renderQueued.has(p)):[packet];
      for(const packet of pendingText)if (packet.operation === 'text_chunk' && accepted && packet.processed_event_id === accepted.processed_event_id) {
        renderQueued.add(packet);
        render = render.then(async () => {
          const chunk = packet.chunk, header = packets.find(p => p.operation === 'result_header' && p.processed_event_id === packet.processed_event_id &&
            p.reply_id === chunk.reply_id && p.reply_epoch === chunk.reply_epoch);
          requireFact(header && (!errandToken||header.reply_id===readyHeader?.reply_id&&header.reply_epoch===readyHeader?.reply_epoch) && chunk.run_id===header.run_id && chunk.event_id === (errandToken?readyHeader?.event_id:eventId) && chunk.target_device_id === pairing.device_id && chunk.seq === rendered + 1);
          rendered++;
          const ack = { output_id: chunk.output_id, reply_id: chunk.reply_id, target_device_id: chunk.target_device_id,
            route_version: chunk.route_version, reply_epoch: chunk.reply_epoch, highest_contiguous_seq: rendered, status: 'rendered', observed_at: new Date().toISOString() };
          await send({ operation: 'ack', processed_event_id: packet.processed_event_id, ack });
          await until(() => regressionRenderedAck(packets,packet.processed_event_id,ack));
        }).catch(error => { failure = error; failureStage = 'text_render'; });
      }
    } catch (error) { failure = error; }
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, sender) => {
    if (track.kind !== TrackKind.KIND_AUDIO || sender.identity !== b.central_text_transport.expected_gateway_identity) return;
    const reader = new AudioStream(track, 24000, 1).getReader(); readers.push(reader);
    receiving.push((async () => { for (;;) { const item = await reader.read(); if (item.done) return;
      for (const value of item.value.data) { samples++; if (Math.abs(value) > 100) loud++; if(speechEnded){replySamples++;if(Math.abs(value)>100)replyLoud++;} } } })().catch(error => { failure = error; }));
  });
  room.on(RoomEvent.TrackSubscriptionFailed, () => { failure = new Error('SIM_AUDIO_SUBSCRIPTION_FAILED'); });
  room.registerByteStreamHandler(wire.voice_topic, (reader, sender) => {
    play = play.then(async () => {
      if (process.argv.includes('--call')) await until(() => packets.some(p => p.operation === 'call_state' && p.call_id === callId && p.state === 'live'));
      requireFact(sender.identity === b.central_text_transport.expected_gateway_identity);
      const packet = valid(JSON.parse(reader.info.attributes!.out!)); requireFact(packet.operation === 'voice_chunk'); const chunk = packet.chunk;
      requireFact(voiceOutputId === undefined || voiceOutputId === chunk.output_id); voiceOutputId = chunk.output_id;
      const audio = inspectWav(Buffer.concat(await reader.readAll()));
      requireFact(packet.event_id === eventId && packets.some(p => p.operation === 'accepted' && p.event_id === eventId && p.processed_event_id === packet.processed_event_id) && chunk.target_device_id === pairing.device_id && chunk.seq === played + 1 &&
        reader.info.mimeType === chunk.audio.mime && audio.bytes.length === chunk.audio.bytes && audio.sha256 === chunk.audio.sha256 &&
        audio.duration_ms === chunk.audio.duration_ms && audio.sample_rate === chunk.sample_rate && audio.channels === chunk.channels && audio.codec === chunk.codec);
      await sleep(audio.duration_ms); played++; duration += audio.duration_ms; bytes += audio.bytes.length;
      const ack = { output_id: chunk.output_id, reply_id: chunk.reply_id, target_device_id: chunk.target_device_id,
        route_version: chunk.route_version, reply_epoch: chunk.reply_epoch, highest_contiguous_seq: played, status: 'played', observed_at: new Date().toISOString() };
      if (callId) requireFact(packets.filter(p => p.operation === 'call_state' && p.call_id === callId).at(-1)?.state === 'live');
      await send({ operation: 'ack', processed_event_id: packet.processed_event_id, ack });
      await until(() => packets.some(p => p.operation === 'ack_receipt' && p.processed_event_id === packet.processed_event_id &&
        Object.entries(ack).every(([key, value]) => p.receipt[key] === value)));
    }).catch(error => { failure = error; failureStage = 'voice_playout'; });
  });
  const eventId = uuid('prompt');
  try {
    requireFact(contentKey && (textOnly && b.central_text_transport?.voice_transport === undefined || b.central_text_transport?.voice_transport === wire.voice_transport) && b.central_text_transport.schema === 'paios.central.text-transport.v1' &&
      b.central_text_transport.input_topic === wire.input_topic && b.central_text_transport.output_topic === wire.output_topic);
    await room.connect(b.livekit.server_url, b.livekit.participant_token, { autoSubscribe: true, dynacast: false,
      encryption: { encryptionType: 1, keyProviderOptions: { ...LIVEKIT_KEY_PROVIDER_DEFAULTS, sharedKey: contentKey! } } });
    if(micTrack){const options=new TrackPublishOptions();options.source=TrackSource.SOURCE_MICROPHONE;await room.localParticipant!.publishTrack(micTrack,options);}
    stage = 'gateway_ready';
    await until(() => gatewayReady, undefined, 15000);
    steps.push({ step: 'gateway_ready', status: 'ready' });
    if(host){const seconds=Number(argument('--desktop-seconds')??300);requireFact(Number.isSafeInteger(seconds)&&seconds>0&&seconds<=3600);timeout=setTimeout(quit,seconds*1000);await until(()=>hostReady,undefined,15000);
      process.stdout.write(JSON.stringify({step:'desktop_host',status:'connected',at_ms:Date.now()})+'\n');
      if(attachmentPath){grant=await host.grant(attachmentPath,(argument('--desktop-via')??'drag') as 'drag'|'paste',Number(argument('--desktop-grant-seconds')??86400));
        await fs.writeFile(join(await fs.realpath(desktop!),'.fixture-grant.json'),JSON.stringify(grant.record),{mode:0o600,flag:'wx'});}
    }
    if(argument('--control'))await control(argument('--control')!);
    if (promptText !== undefined) {
      stage = 'prompt_acceptance';
      const submit = Object.freeze({ operation: 'submit', event_id: eventId, captured_at: new Date().toISOString(), text: promptText,...(grant?{attachments:[grant.attachment]}:{}) });
      attempts = 1; await send(submit);
      // Match the iPhone's recovery: replay the same event until the gateway accepts it.
      await until(() => packets.some(p => p.operation === 'accepted' && p.event_id === eventId), async () => { attempts++; await send(submit); });
      if(grant){process.stdout.write(JSON.stringify({step:'desktop_attachment',status:'accepted',event_id:eventId,grant_id:grant.attachment.grant_id,at_ms:Date.now()})+'\n');
        if(argument('--desktop-revoke-after')){const after=Number(argument('--desktop-revoke-after'));requireFact(Number.isFinite(after)&&after>0);revokeTimer=setTimeout(()=>host!.revoke(grant!.attachment.grant_id),after*1000);}}

    }
    if (process.argv.includes('--call')) {
      stage = 'call_audio';
      callId = uuid('call'); before = loud; beforeSamples = samples; await send({ operation: 'call_open', call_id: callId });
      await until(() => loud > before && packets.some(p => p.operation === 'call_state' && p.call_id === callId && p.state === 'live'));
      if(mic){
        const sent=await playRecordedCallSpeech(readFileSync(argument('--speech')!),mic,{
          // Speech heard before its Face ID confirmation stays an unanswered observation: any answered user turn completes.
          inputEnded:()=>{speechEnded=true;},complete:()=>until(()=>replyLoud>0&&packets.some(a=>a.operation==='call_transcript'&&a.call_id===callId&&
            a.role==='assistant'&&a.final&&a.text?.trim()&&packets.some(p=>p.operation==='call_transcript'&&p.call_id===callId&&p.turn===a.turn&&p.role==='user'&&p.final&&p.text?.trim()))),
          audibleSamples:()=>replyLoud,check:()=>{if(failure)throw failure;}});
        steps.push({step:'speech_playback',status:'played',sent_samples:sent,reply_samples:replySamples,audible_samples:replyLoud,evidence:'decoded_livekit_audio'});
      }
    }
    if (promptText !== undefined) {
      stage = 'result_header';
      await until(() => readyHeader !== undefined);
      if(errandToken)requireFact(readyHeader!.text_chunk_count>0);
      const delivery = readyHeader!.reply_mode === 'text' ? 'rendered' : 'played';
      stage = delivery === 'rendered' ? 'text_render' : 'voice_playout';
      await until(() => played >= expectedVoice! && rendered >= readyHeader!.text_chunk_count);
      await render; await play; if (failure) throw failure;
      stage = 'persisted_played';
      const deliveryEvent=errandToken?readyHeader!.event_id:eventId;
      const processed = packets.find(p => p.operation === 'accepted' && p.event_id === deliveryEvent)!.processed_event_id;
      const beforeQuery = packets.length;
      await send({operation:'result',processed_event_id:processed});
      await until(() => packets.slice(beforeQuery).some(p => p.operation === 'result_header' && p.event_id === deliveryEvent && p.delivery_status === delivery));
      const header = packets.slice(beforeQuery).filter(p => p.operation === 'result_header' && p.event_id === deliveryEvent).at(-1)!;
      requireFact((delivery === 'rendered' ? rendered > 0 : played > 0) && header.pending_voice_chunk_count === 0 && header.pending_text_chunk_count === 0 && header.run_status === 'completed' && header.reply_phase === 'sealed' && header.receipt_status === 'complete' && !header.voice_error && !header.receipt_error);
      if(grant)process.stdout.write(JSON.stringify({step:'desktop_attachment',status:delivery,event_id:eventId,grant_id:grant.attachment.grant_id,at_ms:Date.now()})+'\n');
      let errand:Json|undefined;
      if(errandToken){
        await until(()=>packets.some(p=>p.operation==='result_header'&&p.event_id===eventId&&p.run_status==='completed'&&p.reply_phase==='sealed'));
        const original=packets.filter(p=>p.operation==='result_header'&&p.event_id===eventId).at(-1)!;
        requireFact(original.reply_mode==='none'||original.reply_mode==='text');
        const chunk=packets.find(p=>p.operation==='text_chunk'&&p.processed_event_id===processed&&p.chunk.reply_id===header.reply_id)!.chunk;
        errand={token:errandToken,job_id:deliveryEvent.slice(7),event_id:deliveryEvent,processed_event_id:processed,run_id:header.run_id,
          output_id:chunk.output_id,reply_id:header.reply_id,reply_epoch:header.reply_epoch,route_version:chunk.route_version,
          target_device_id:pairing.device_id,highest_contiguous_seq:rendered,status:delivery};
      }
      steps.push({ step: 'prompt_playback', status: delivery,...(regressionEvidence?(errand?regressionFailureBinding(eventId,packets):{event_id:eventId,processed_event_id:processed,run_id:header.run_id}):{}),...(errand?{errand}:{}), submit_attempts: attempts, chunks: played, rendered_chunks: rendered, wav_bytes: bytes, duration_ms: duration,
        ack_receipts: packets.filter(p => p.operation === 'ack_receipt').length, receipt_refs: header.receipt_refs.length, evidence: delivery === 'rendered' ? 'headless_text_render' : 'headless_duration_playout' });
    }
    if(host)await stop.promise;
    if (process.argv.includes('--call')) {
      stage = 'call_close';
      await send({ operation: 'call_close', call_id: callId, reason: 'button' });
      await until(() => packets.some(p => p.operation === 'call_state' && p.call_id === callId && p.state === 'closed' && p.reason === 'button'));
      requireFact(['opening', 'live', 'closing', 'closed'].every(state => packets.some(p => p.operation === 'call_state' && p.call_id === callId && p.state === state)));
      steps.push({ step: 'call', status: 'closed',...(regressionEvidence?{call_id:callId,session_id:b.continuity_id,device_id:pairing.device_id,principal_id:pairing.user_id,turns:packets.filter(p=>p.operation==='call_transcript'&&p.call_id===callId&&p.role==='user'&&p.final).map(p=>p.turn)}:{}), decoded_samples: samples - beforeSamples, audible_samples: loud - before,
        playback_receipts: packets.filter(p => p.operation === 'ack_receipt').length });
    }
  } catch (error) {
    playbackFailed = true;
    const lastCallState = packets.filter(p => p.operation === 'call_state' && p.call_id === callId).at(-1)?.state;
    const header = packets.filter(p => p.operation === 'result_header' && p.event_id === eventId).at(-1);
    const headerStatus = header ? Object.fromEntries(['reply_mode', 'voice_status', 'run_status', 'reply_phase', 'receipt_status', 'delivery_status']
      .filter(key => typeof header[key] === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(header[key])).map(key => [key, header[key]])) : undefined;
    steps.push({ step: 'playback', status: 'failed', stage: failureStage ?? stage,
      ...(regressionEvidence ? regressionFailureBinding(eventId,packets) : {}),
      error_name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error',
      ...(error instanceof Error && safeErrorCode(error.message) ? { error_code: error.message } : {}),
      ...(header ? { result_header: { ...headerStatus, pending_voice_chunk_count: header.pending_voice_chunk_count,
        ...Object.fromEntries(['voice_error', 'receipt_error'].filter(key => safeErrorCode(header[key])).map(key => [key, header[key]])) } } : {}),
      operation_counts: Object.fromEntries(Object.keys(wire.outputs).map(operation => [operation, packets.filter(p => p.operation === operation).length]).filter(([, count]) => count)),
      played_chunks: played, decoded_samples: samples, audible_samples: loud,
      ...(['opening', 'live', 'closing', 'closed', 'failed'].includes(lastCallState) ? { last_call_state: lastCallState } : {}) });
  }
  finally { await errandStore?.close();clearTimeout(timeout);clearTimeout(revokeTimer);process.off('SIGINT',quit);process.off('SIGTERM',quit);await host?.close();await micTrack?.close();await mic?.close();await room.disconnect(); await Promise.allSettled(readers.map(reader => reader.cancel())); await Promise.allSettled(receiving); dispose(); }
}
if(desktop){process.stdout.write(JSON.stringify({steps})+'\n');if(playbackFailed)process.exitCode=1;return;}
record('credential_refresh', await post('/v1/realtime/credentials/refresh', withContext({ operation: 'connected_credential_refresh',
  request_id: uuid('refresh'), ...common, refresh_reason: 'server_refresh' }, b.realtime_session_ref)));
record('media_stop', await post('/v1/realtime/media/stop', withContext({ operation: 'media_stop', request_id: uuid('stop'), ...common,
  reason: 'user_stop', release_scope: 'media_device_lease_only' }, b.device_lease_ref)));
record('end_continuity', await post('/v1/realtime/end-continuity', withContext({ operation: 'end_continuity', request_id: uuid('end'),
  realtime_session_ref: b.realtime_session_ref, continuity_id: b.continuity_id, connection_epoch: b.connection_epoch,
  confirmation: 'explicit_user_end_continuity', governance: pairing.governance }, b.realtime_session_ref)));
process.stdout.write(JSON.stringify({ steps, ...(migration ? {origin_migration: migration.events, origin_state: migration.summary()} : {}) }, null, 1) + '\n');
const expected: Json = { bootstrap: 'bootstrap_accepted', bootstrap_replay: 'bootstrap_accepted', bootstrap_reconcile: 'committed', e2ee_key_resolve: 'key_resolved', credential_refresh: 'credential_refreshed', media_stop: 'success', end_continuity: 'success' };
if (playbackFailed || steps.some(step => step.http !== undefined && (step.http !== 200 || step.status !== expected[step.step]) || step.identical === false || step.binding === false || step.committed === false) || !opened.opened || opened.content_key_bytes !== 32) process.exitCode = 1;

}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
