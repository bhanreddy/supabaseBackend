/** Repeatable local verification. Never reads the application's database credentials. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const frontend=path.resolve(backend,'../SchoolIMS-Frontend');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'schoolims-transport-verify-'));
const reportDir=path.join(backend,'docs/transport-repair/verification');fs.mkdirSync(reportDir,{recursive:true});
const env={...process.env,DOTENV_CONFIG_PATH:'/dev/null',EXPO_NO_DOTENV:'1',NODE_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_ANON_KEY:'local-test-placeholder',SUPABASE_SERVICE_ROLE_KEY:'local-test-placeholder',FIREBASE_PROJECT_ID:'',FIREBASE_CLIENT_EMAIL:'',FIREBASE_PRIVATE_KEY:'',LOG_LEVEL:'silent'};
const results=[];
function run(name,command,args,cwd=backend,extraEnv={}){
  const result=spawnSync(command,args,{cwd,env:{...env,...extraEnv},encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
  fs.writeFileSync(path.join(reportDir,name+'.txt'),(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):''));
  results.push({check:name,passed:result.status===0,exit_code:result.status});
  console.log(`${result.status===0?'PASS':'FAIL'} ${name}`);
  if(result.status!==0)throw new Error(`${name} failed; see ${path.join(reportDir,name+'.txt')}`);
  return result.stdout;
}
let started=false;
try{
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  run('postgres-initialize','initdb',['-D',path.join(work,'data'),'-A','trust','--no-locale']);
  run('postgres-start','pg_ctl',['-D',path.join(work,'data'),'-l',path.join(work,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'start']);started=true;
  run('backend-transport-unit',process.execPath,['--test','services/transportPhaseE.test.js','services/transportCalibrationService.test.js','services/transportCalibrationAdminService.test.js','services/transportProactiveNotificationService.test.js']);
  run('backend-transport-integration',process.execPath,['--experimental-test-module-mocks','--test','tests/transportReliability.integration.js'],backend,{TRANSPORT_TEST_DATABASE_URL:`postgres://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:${port}/postgres`});
  run('frontend-transport',process.execPath,['scripts/run-tests.cjs','--runInBand','--watch=false','--runTestsByPath','src/services/driverLocationTask.test.ts','src/services/driverLocationPermissionFlow.test.ts'],frontend);
  const output=run('native-config',process.execPath,['node_modules/expo/bin/cli','config','--type','introspect','--json'],frontend);
  const config=JSON.parse(output);
  const permissions=config.android?.permissions||[];
  for(const permission of ['ACCESS_BACKGROUND_LOCATION','FOREGROUND_SERVICE_LOCATION'])if(!permissions.includes(`android.permission.${permission}`))throw new Error(`Missing native permission ${permission}`);
  if(!config.ios?.infoPlist?.UIBackgroundModes?.includes('location'))throw new Error('Missing iOS background location mode');
  // Keep only relevant configuration evidence, not the entire generated app config.
  fs.writeFileSync(path.join(reportDir,'native-config.txt'),JSON.stringify({android_location_permissions:permissions.filter(p=>/LOCATION|FOREGROUND_SERVICE/.test(p)),ios_background_modes:config.ios.infoPlist.UIBackgroundModes},null,2)+'\n');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
  if(started)spawnSync('pg_ctl',['-D',path.join(work,'data'),'-m','fast','stop'],{encoding:'utf8',timeout:15000});
  fs.rmSync(work,{recursive:true,force:true});
  fs.writeFileSync(path.join(reportDir,'results.json'),JSON.stringify({date:new Date().toISOString(),passed:!process.exitCode,checks:results,physical_device_tests:'not_run',production_deployment:'not_run'},null,2)+'\n');
}
