// Ordinary Claude, production account hooks, synthetic grants and local HTTP.
// No startup preload, launcher, real account or provider inference is used.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const root=fileURLToPath(new URL('../',import.meta.url))
const fixture=mkdtempSync(join(tmpdir(),'rice-public-auth-'))
const plugin=join(fixture,'plugin'), driver=join(fixture,'driver'), config=join(fixture,'.claude')
const native=process.env.RICE_ACCOUNTS_PROOF_CLAUDE||'claude'
// The qualified native cohorts this proof runs against; another release needs its own qualification.
const allowedVersions=['2.1.301','2.1.302']
const storageBaseline=process.argv.includes('--baseline-storage')
const started=Date.now(), requests=[], results=[]
const tokenA='owned-public-oauth-a', tokenB='owned-public-oauth-b'
const rotatedTokenA='owned-public-oauth-a-renewed'
// An apiKeyHelper's key, which Claude Code sends in place of any selected bearer.
const helperKey='owned-public-helper-key'
const waitMs=process.platform==='win32'?45000:15000
const childMs=process.platform==='win32'?120000:60000
let child, baseline, helper, timedOut=false

function stop(process) {
  if(!process||process.exitCode!==null)return
  if(globalThis.process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(process.pid),'/T','/F'],{stdio:'ignore',timeout:10000,windowsHide:true})
  else try{globalThis.process.kill(-process.pid,'SIGTERM')}catch{}
}
const waitSource=`const fs=require('node:fs');const [path,limit]=process.argv.slice(1);(async()=>{const end=Date.now()+Number(limit);while(!fs.existsSync(path)){if(Date.now()>end){process.exitCode=3;return}await new Promise(r=>setTimeout(r,25))}})().catch(()=>{process.exitCode=4})`
new Script(waitSource)

function respond(response,model,account,tool) {
  const reset=String(Math.floor(Date.now()/1000)+3600)
  response.writeHead(200,{'content-type':'text/event-stream','anthropic-ratelimit-unified-status':account==='a'?'rejected':'allowed',
    'anthropic-ratelimit-unified-representative-claim':account==='a'?'seven_day':'five_hour','anthropic-ratelimit-unified-reset':reset,
    'anthropic-ratelimit-unified-5h-utilization':account==='a'?'1':'0.01','anthropic-ratelimit-unified-5h-reset':reset,
    'anthropic-ratelimit-unified-7d-utilization':account==='a'?'1':'0.02','anthropic-ratelimit-unified-7d-reset':reset})
  const send=(event,value)=>response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  send('message_start',{type:'message_start',message:{id:`owned-${requests.length}`,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}})
  if(tool){
    send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'owned-read-barrier',name:'Read',input:{}}})
    send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:join(fixture,'pause.txt')})}})
  }else{
    send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
    send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OWNED_PUBLIC_AUTH_OK'}})
  }
  send('content_block_stop',{type:'content_block_stop',index:0})
  send('message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}})
  send('message_stop',{type:'message_stop'});response.end()
}
const server=createServer(async(request,response)=>{
  if(request.method!=='POST'||!request.url?.startsWith('/v1/messages')){response.writeHead(404);response.end();return}
  let text='';for await(const bytes of request)text+=bytes
  const body=JSON.parse(text), messages=JSON.stringify(body.messages)
  const role=['FRESH','RESTORED','CHILD_STREAM','CHILD','LATE_A','EXISTING_A','B_AFTER_LATE','HELPER'].find(name=>messages.includes('OWNED_'+name))||'MAIN'
  const bearer=request.headers.authorization
  const account=[`Bearer ${tokenA}`,`Bearer ${rotatedTokenA}`].includes(bearer)?'a':bearer===`Bearer ${tokenB}`?'b':bearer===`Bearer ${helperKey}`?'helper':'unexpected'
  const index=requests.filter(row=>row.role===role).length
  requests.push({role,index,account,apiKey:request.headers['x-api-key']!==undefined,renewedBaseline:bearer===`Bearer ${rotatedTokenA}`,elapsedMs:Date.now()-started})
  writeFileSync(join(fixture,'request-'+role),'observed')
  if(role==='LATE_A'&&index===0){
    const until=Date.now()+childMs-5000
    while(!existsSync(join(fixture,'release-late'))){if(Date.now()>until){response.writeHead(504);response.end();return}await delay(25)}
  }
  respond(response,body.model,account,role==='EXISTING_A'&&index===0)
})

try {
  for(const directory of ['.claude-plugin','hooks','types','scripts'])cpSync(join(root,directory),join(plugin,directory),{recursive:true})
  mkdirSync(join(config,'rice-session-accounts'),{recursive:true});mkdirSync(join(fixture,'tmp'))
  const machineMetadata={hasCompletedOnboarding:true,oauthAccount:{emailAddress:'machine@example.test',accountUuid:'owned-machine',organizationUuid:'owned-org'}}
  writeFileSync(join(fixture,'.claude.json'),JSON.stringify(machineMetadata))
  writeFileSync(join(config,'.claude.json'),JSON.stringify(machineMetadata))
  writeFileSync(join(config,'settings.json'),JSON.stringify({model:'haiku'}))
  writeFileSync(join(fixture,'pause.txt'),'Owned read-only account-switch barrier.\n')
  const folders={'account-a':join(fixture,'account-a'),'account-b':join(fixture,'account-b')}
  const credential=(token)=>({claudeAiOauth:{accessToken:token,refreshToken:'owned-refresh',expiresAt:Date.now()+3600000,scopes:['user:inference','user:profile'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x'}})
  const references={}
  for(const [name,folder] of [...Object.entries(folders),['login',config]]){
    mkdirSync(folder,{recursive:true})
    const value=credential(name==='account-b'?tokenB:tokenA)
    const service='Claude Code-credentials-'+createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0,8)
    references[service]=value;references[folder+'/.credentials.json']=value
    writeFileSync(join(folder,'.credentials.json'),JSON.stringify(value),{mode:0o600})
    if(name!=='login')writeFileSync(join(folder,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:name+'@example.test'}}))
  }
  writeFileSync(join(config,'rice-session-accounts/accounts.json'),JSON.stringify({default:'account-b',accounts:{login:{kind:'login'},...Object.fromEntries(Object.entries(folders).map(([name,loginDir])=>[name,{kind:'claudeai',loginDir}]))}}))
  const protectedFiles=[join(config,'settings.json'),join(config,'rice-session-accounts/accounts.json'),join(config,'.credentials.json')]
  const before=protectedFiles.map(file=>readFileSync(file,'utf8'))
  let expectedMachineCredential=before[2],originalCredentialPreservedBeforeRenewal=true
  const register=join(plugin,'hooks/register.ts'), production=readFileSync(register,'utf8')
  const helpers=`
const proofDirectory=${JSON.stringify(fixture)}
const proofCredentials:Record<string,unknown>=${JSON.stringify(references)}
const proofMachineRefs=new Set(${JSON.stringify([config+'/.credentials.json','Claude Code-credentials-'+createHash('sha256').update(config.normalize('NFC')).digest('hex').slice(0,8)])})
let proofPrepared=false
const proofWait=async($:EngineInterface,name:string)=>{const r=await $.process.run(['node','-e',${JSON.stringify(waitSource)},proofDirectory+'/'+name,${JSON.stringify(String(waitMs))}],{timeoutMs:${waitMs+5000}});if(r.exitCode!==0)throw Error('owned barrier failed: '+name)}
`
  const hooks=`
  on('http.fetch',{url:USAGE_URL},async(_$,e,next)=>{
    const isA=${JSON.stringify(['Bearer '+tokenA,'Bearer '+rotatedTokenA])}.includes(e.init?.headers?.Authorization??'')
    return {value:{ok:true,status:200,headers:{},text:JSON.stringify({five_hour:{utilization:isA?100:1},seven_day:{utilization:isA?100:2}})}}
  })
  on('http.fetch',{url:PROFILE_URL},async(_$,e)=>({value:{ok:true,status:200,headers:{},text:JSON.stringify({selectedA:${JSON.stringify(['Bearer '+tokenA,'Bearer '+rotatedTokenA])}.includes(e.init?.headers?.Authorization??''),selectedB:e.init?.headers?.Authorization===${JSON.stringify('Bearer '+tokenB)},nativeHandleRemoved:e.init?.auth===undefined,oauthBeta:e.init?.headers?.['anthropic-beta']?.includes('oauth-2025-04-20')===true})}}))
  on('process.run',{argv:[/^(?:node|\\/usr\\/bin\\/security)$/]},async($,e,next)=>{
    let ref:string|undefined
    if(e.argv[0]==='/usr/bin/security'&&e.argv[1]==='find-generic-password')ref=e.argv[e.argv.indexOf('-s')+1]
    if(e.argv[0]==='node'&&e.argv[3]==='read'&&e.argv[4]?.endsWith('/.credentials.json'))ref=e.argv[4]
    if(ref===undefined)return next(e)
    if(!Object.hasOwn(proofCredentials,ref))throw Error('unowned credential reference')
    if(proofMachineRefs.has(ref))return {value:{exitCode:0,stdout:await $.fs.read(${JSON.stringify(config+'/.credentials.json')}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
    return {value:{exitCode:0,stdout:JSON.stringify(proofCredentials[ref]),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('tool.call',{tool:'Read'},async($,e,next)=>{const result=await next(e);await $.fs.write(proofDirectory+'/read-ready','ready');await proofWait($,'release-read');return result})
  on('turn.complete',{agentId:/./},async($,e,next)=>{if(e.agentId!==undefined)await $.fs.write(proofDirectory+'/completed-'+e.agentId,e.reason);return next(e)})
  on('turn.step',{index:0},async function*($,e,next){
    if(e.agentId!==undefined||proofPrepared||await $.env.get('RICE_ACCOUNTS_PROOF_ROLE')!=='controller')return yield*next(e)
    proofPrepared=true
    try {
      await runCommand($,'account-a')
      const late=await $.agent.spawn({prompt:'OWNED_LATE_A: answer briefly.',description:'Owned held A',subagentType:'general-purpose',model:'haiku'})
      if(!late.agentId)throw Error('owned late agent missing');await proofWait($,'request-LATE_A')
      const existing=await $.agent.spawn({prompt:'OWNED_EXISTING_A: read the owned fixture then answer briefly.',description:'Owned existing A',subagentType:'general-purpose',model:'haiku'})
      if(!existing.agentId)throw Error('owned existing agent missing');await proofWait($,'read-ready')
      const usageA=await $.session.usage()
      const switched=await runCommand($,'account-b'),usageAfterSwitch=await $.session.usage()
      await $.fs.write(proofDirectory+'/release-read','released');await proofWait($,'completed-'+existing.agentId)
      await $.fs.write(proofDirectory+'/release-late','released');await proofWait($,'completed-'+late.agentId)
      const usageAfterLateA=await $.session.usage()
      const after=await $.agent.spawn({prompt:'OWNED_B_AFTER_LATE: answer briefly.',description:'Owned B after late A',subagentType:'general-purpose',model:'haiku'})
      if(!after.agentId)throw Error('owned B agent missing');await proofWait($,'completed-'+after.agentId)
      const childArgs=[${JSON.stringify(native)},'-p','--plugin-dir',${JSON.stringify(plugin)},'--setting-sources','user','--strict-mcp-config','--no-session-persistence','--output-format','json']
      const directChild=await $.process.run([...childArgs,'OWNED_CHILD: answer briefly.'],{env:{CLAUDECODE:'',RICE_ACCOUNTS_PROOF_ROLE:'child'},timeoutMs:${waitMs}})
      const directResult=JSON.parse(directChild.stdout)
      let streamed=''
      for await(const chunk of $.process.spawn({argv:[...childArgs,'OWNED_CHILD_STREAM: answer briefly.'],env:{CLAUDECODE:'',RICE_ACCOUNTS_PROOF_ROLE:'child'}})){if(chunk.stream==='stdout')streamed+=chunk.text}
      const streamedResult=JSON.parse(streamed)
      const nativeSourcePreserved=(await $.env.get('CLAUDE_CODE_OAUTH_TOKEN'))===${JSON.stringify(storageBaseline?undefined:tokenA)}&&(await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'))===${JSON.stringify(config)}
      await $.fs.write(proofDirectory+'/observations.json',JSON.stringify({usageA,switched,usageAfterSwitch,usageAfterLateA,nativeSourcePreserved,children:{runExitCode:directChild.exitCode,runAnswer:directResult.result==='OWNED_PUBLIC_AUTH_OK',spawnAnswer:streamedResult.result==='OWNED_PUBLIC_AUTH_OK',runError:directResult.is_error,spawnError:streamedResult.is_error}}))
      return yield*next(e)
    }catch(error){await $.fs.write(proofDirectory+'/failure.json',JSON.stringify({error:error instanceof Error?error.message:'unknown'}));throw error}
  })
`
  const decorated=production.replace('export const register: Register = on => {',helpers+'\nexport const register: Register = on => {')
  assert.notEqual(decorated,production,'production registration seam must be found')
  const closing=decorated.lastIndexOf('\n}')
  writeFileSync(register,decorated.slice(0,closing)+hooks+decorated.slice(closing))
  mkdirSync(join(driver,'.claude-plugin'),{recursive:true});mkdirSync(join(driver,'hooks'))
  writeFileSync(join(driver,'.claude-plugin/plugin.json'),JSON.stringify({name:'owned-account-consumer',version:'1.0.0'}))
  writeFileSync(join(driver,'hooks/hooks.json'),JSON.stringify({modules:['./register.ts']}))
  writeFileSync(join(driver,'hooks/register.ts'),`import type {Register,SessionAuthorization} from 'claude-code'
let cached:SessionAuthorization=null,startup:SessionAuthorization=null
export const register:Register=on=>{
  on('session.start',async($,e,next)=>{const r=await next(e);startup=await $.session.authorize();await $.command.register({name:'owned-account-auth',description:'Owned selected account authorization fixture'});return r})
  on('command.run',{command:'owned-account-auth'},async($)=>{
    const auth=await $.session.authorize();if(!auth)throw Error('selected account authorization missing')
    const first=cached===null;cached??=auth
    let disabledRefused=false
    try{await $.http.fetch('https://api.anthropic.com/api/oauth/profile',{auth:cached.handle})}catch{disabledRefused=true}
    await $.env.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',undefined)
    try{
      const profile=await $.http.fetch('https://api.anthropic.com/api/oauth/profile',{auth:cached.handle})
      const startupProfile=first&&startup?JSON.parse((await $.http.fetch('https://api.anthropic.com/api/oauth/profile',{auth:startup.handle})).text):null
      return {text:JSON.stringify({kind:auth.kind,disabledRefused,profile:JSON.parse(profile.text),startupProfile})}
    }finally{await $.env.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','1')}
  })
}
`)
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const env=Object.fromEntries(['PATH','LANG','LC_ALL','SystemRoot','SystemDrive','ComSpec','PATHEXT','ProgramFiles','ProgramFiles(x86)'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]))
  Object.assign(env,{HOME:fixture,USER:'fixture',USERPROFILE:fixture,TMPDIR:join(fixture,'tmp'),CLAUDE_CONFIG_DIR:config,CLAUDE_SECURESTORAGE_CONFIG_DIR:config,...(storageBaseline?{}:{CLAUDE_CODE_OAUTH_TOKEN:tokenA}),ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',RICE_ACCOUNTS_PROOF_ROLE:'controller'})
  if(process.platform==='win32')Object.assign(env,{OS:'Windows_NT',USERNAME:'fixture',TEMP:join(fixture,'tmp'),TMP:join(fixture,'tmp')})
  const version=spawnSync(native,['--version'],{cwd:fixture,env,encoding:'utf8',timeout:10000})
  assert.equal(version.status,0,'ordinary Claude prerequisite must run')
  const nativeVersion=/^(\S+) \(Claude Code\)$/.exec(version.stdout.trim())?.[1]
  assert.ok(allowedVersions.includes(nativeVersion),`public auth proof requires a qualified native cohort (${allowedVersions.join(', ')}); found ${JSON.stringify(version.stdout.trim())}. Compatibility unit cohorts are separate.`)
  const validated=spawnSync(native,['plugin','validate',plugin],{cwd:fixture,env,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024})
  assert.equal(validated.status,0,validated.stdout||'owned production fixture validation failed')
  child=spawn(native,['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--plugin-dir',plugin,'--plugin-dir',driver,'--setting-sources','user','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Agent,Read','--no-session-persistence'],{cwd:fixture,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  console.error(JSON.stringify({phase:'owned-native-started',pid:child.pid,platform:process.platform,nativeVersion,preload:false,productionSourceSha256:createHash('sha256').update(production).digest('hex')}))
  const send=text=>child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n')
  let pending='',stderr=''
  child.stderr.on('data',bytes=>stderr+=bytes)
  child.stdout.on('data',bytes=>{
    pending+=bytes
    let newline
    while((newline=pending.indexOf('\n'))!==-1){
      const line=pending.slice(0,newline);pending=pending.slice(newline+1)
      let event;try{event=JSON.parse(line)}catch{continue}
      if(event.type!=='result')continue
      results.push({subtype:event.subtype,isError:event.is_error,text:event.result})
      if(results.length===1)send('/usage')
      else if(results.length===2)send('/owned-account-auth')
      else if(results.length===3)send('/status')
      else if(results.length===4){
        originalCredentialPreservedBeforeRenewal=readFileSync(protectedFiles[2],'utf8')===before[2]
        if(storageBaseline){
          // Simulate an ordinary vendor renewal by another process. The
          // plugin must restore the current native source, not pin old A.
          expectedMachineCredential=JSON.stringify(credential(rotatedTokenA))
          writeFileSync(protectedFiles[2],expectedMachineCredential,{mode:0o600})
        }
        send('/rice-account login')
      }
      else if(results.length===5)send('/owned-account-auth')
      else if(results.length===6)send('OWNED_RESTORED: answer briefly.')
      else child.stdin.end()
    }
  })
  send('Owned main native public authentication fixture')
  const timer=setTimeout(()=>{timedOut=true;stop(child)},childMs)
  const [exitCode]=await once(child,'close');clearTimeout(timer)
  baseline=spawn(native,['-p','--plugin-dir',plugin,'--setting-sources','user','--strict-mcp-config','--no-session-persistence','--output-format','json','OWNED_FRESH: answer briefly.'],{cwd:fixture,env:{...env,RICE_ACCOUNTS_PROOF_ROLE:'baseline'},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  console.error(JSON.stringify({phase:'owned-fresh-native-started',pid:baseline.pid}))
  let freshOutput='';baseline.stdout.on('data',bytes=>freshOutput+=bytes);baseline.stderr.resume()
  const freshTimer=setTimeout(()=>stop(baseline),waitMs)
  const [freshExitCode]=await once(baseline,'close');clearTimeout(freshTimer)
  // A session whose apiKeyHelper (here from --settings) would carry its requests:
  // /rice-account must refuse before anything changes, and nothing may go out on B.
  writeFileSync(join(fixture,'helper-settings.json'),JSON.stringify({apiKeyHelper:'echo '+helperKey}))
  const helperResults=[]
  helper=spawn(native,['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--plugin-dir',plugin,'--setting-sources','user','--settings',join(fixture,'helper-settings.json'),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence'],{cwd:fixture,env:{...env,RICE_ACCOUNTS_PROOF_ROLE:'helper'},stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  console.error(JSON.stringify({phase:'owned-helper-native-started',pid:helper.pid}))
  const sendHelper=text=>helper.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n')
  let helperPending=''
  helper.stderr.resume()
  helper.stdout.on('data',bytes=>{
    helperPending+=bytes
    let newline
    while((newline=helperPending.indexOf('\n'))!==-1){
      const line=helperPending.slice(0,newline);helperPending=helperPending.slice(newline+1)
      let event;try{event=JSON.parse(line)}catch{continue}
      if(event.type!=='result')continue
      helperResults.push({subtype:event.subtype,isError:event.is_error,text:event.result})
      if(helperResults.length===1)sendHelper('OWNED_HELPER: answer briefly.')
      else helper.stdin.end()
    }
  })
  sendHelper('/rice-account account-b')
  const helperTimer=setTimeout(()=>stop(helper),childMs)
  const [helperExitCode]=await once(helper,'close');clearTimeout(helperTimer)
  const read=name=>existsSync(join(fixture,name))?JSON.parse(readFileSync(join(fixture,name),'utf8')):null
  const observations=read('observations.json'),failure=read('failure.json')
  const settingsUnchanged=protectedFiles.every((file,index)=>readFileSync(file,'utf8')===(index===2?expectedMachineCredential:before[index]))
  const receipt={scope:'production hooks in ordinary unmodified Claude; local synthetic native SDK',platform:process.platform,baseline:storageBaseline?'native-storage':'environment-token',exitCode,freshExitCode,helperExitCode,helperResults,timedOut,elapsedMs:Date.now()-started,requests,observations,failure,results,settingsUnchanged,preload:false,launchers:false,stderrChars:stderr.length,freshAnswer:freshOutput.includes('OWNED_PUBLIC_AUTH_OK')}
  console.log(JSON.stringify(receipt))
  assert.equal(failure,null,'owned public production fixture must complete')
  assert.equal(exitCode,0);assert.equal(freshExitCode,0)
  assert.equal(observations.usageA.rateLimits.some(limit=>limit.percentUsed===100),true,'A must establish exhausted native/session usage')
  assert.equal(observations.usageAfterSwitch.rateLimits.some(limit=>limit.percentUsed===100),false,'selected B usage must replace A immediately')
  assert.equal(observations.usageAfterLateA.rateLimits.some(limit=>limit.percentUsed===100),false,'late A headers must not replace selected B reporting')
  assert.equal(observations.nativeSourcePreserved,true,'selected account headers must preserve native baseline credential ownership and refresh inputs')
  assert.equal(originalCredentialPreservedBeforeRenewal,true,'selecting B must not change the original native grant')
  assert.equal(requests.find(row=>row.role==='EXISTING_A')?.account,'a')
  assert.equal(requests.some(row=>row.role==='EXISTING_A'&&row.account==='b'),true,'already-running agent must use B on its next request')
  for(const role of ['B_AFTER_LATE','CHILD','CHILD_STREAM','MAIN'])assert.equal(requests.find(row=>row.role===role)?.account,'b',role+' must use B')
  assert.deepEqual(observations.children,{runExitCode:0,runAnswer:true,spawnAnswer:true,runError:false,spawnError:false},'both public process APIs must keep B in an ordinary claude -p descendant')
  for(const role of ['RESTORED','FRESH'])assert.equal(requests.find(row=>row.role===role)?.account,'a',role+' must preserve normal login A')
  if(storageBaseline)for(const role of ['RESTORED','FRESH'])assert.equal(requests.find(row=>row.role===role)?.renewedBaseline,true,role+' must use the current renewed native grant, not an old access token')
  assert.equal(results.length,7,'one ordinary session must process inference, reporting, cached authorization, login restoration and later inference')
  assert.match(results[1].text,/account-b usage:[\s\S]*wk 2%/,'native user-entered /usage must show selected B usage')
  const authText=results[2].text,authResult=JSON.parse(authText.slice(authText.indexOf('{')))
  const selectedB={selectedA:false,selectedB:true,nativeHandleRemoved:true,oauthBeta:true}
  assert.deepEqual(authResult.profile,selectedB,'a distinct native consumer must authorize selected B')
  assert.deepEqual(authResult.startupProfile,selectedB,'a cached native authorization observed before selection must use B on its next request')
  assert.equal(authResult.disabledRefused,true,'selected credentials must respect the disabled-network boundary')
  assert.equal(results[3].text,"/status isn't available in this environment.",'the native print frontend rejects /status before dispatch; interactive status and public operation tests have separate scope')
  assert.match(results[4].text,/back on this machine/)
  const restoredText=results[5].text,restoredAuth=JSON.parse(restoredText.slice(restoredText.indexOf('{')))
  assert.deepEqual(restoredAuth.profile,{selectedA:true,selectedB:false,nativeHandleRemoved:true,oauthBeta:true},'the same cached session handle must return to restored A after /login')
  assert.equal(settingsUnchanged,true,'switches must not write machine settings or account configuration')
  assert.equal(helperExitCode,0)
  assert.match(helperResults[0]?.text??'',/This session cannot switch accounts: .*apiKeyHelper/,'an apiKeyHelper session must refuse the switch up front')
  assert.doesNotMatch(helperResults[0]?.text??'',/now uses/,'the refused switch must not be reported as in effect')
  const helperRequests=requests.filter(row=>row.role==='HELPER')
  assert.equal(helperRequests.length>0,true,'the apiKeyHelper session must still answer on its own key')
  assert.deepEqual([...new Set(helperRequests.map(row=>row.account))],['helper'],'the apiKeyHelper session must never send the B bearer')
  assert.equal(helperRequests.every(row=>row.apiKey),true,"the apiKeyHelper key goes out as x-api-key, which is why a header bearer cannot win")
} finally {
  for(const process of [child,baseline,helper])if(process&&process.exitCode===null){stop(process);await once(process,'close').catch(()=>{})}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  rmSync(fixture,{recursive:true,force:true})
}
