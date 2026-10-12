import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decodeXmlAttribute,
  evaluateDotnetPackageGovernance,
  extractElements,
  extractPropertyValues,
  isConcreteStableVersion,
  loadDotnetPackageInventory,
  normalizePackageId,
  parseAttributes,
  parseCentralPackageCatalog,
  parseProjectFile,
  renderDotnetPackageGovernanceMarkdown,
} from './dotnet-package-governance.mts';

const central = entries => `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>${entries.map(([id,version])=>`<PackageVersion Include="${id}" Version="${version}" />`).join('')}</ItemGroup>
</Project>`;

const project = ({ packages = [], projectReferences = [], body = '' } = {}) => `<Project>
  <ItemGroup>
    ${packages.map(value => typeof value === 'string' && value.trimStart().startsWith('<PackageReference') ? value : `<PackageReference Include="${value}" />`).join('')}
    ${projectReferences.map(value => `<ProjectReference Include="${value}" />`).join('')}
  </ItemGroup>
  ${body}
</Project>`;

const evaluate = ({ catalog = [['A','1.0.0']], projects = [{ path:'App/App.csproj', xml:project({packages:['A']}) }] } = {}) =>
  evaluateDotnetPackageGovernance({ centralXml:central(catalog), projects });

test('decodeXmlAttribute decodes the five predefined XML entities', () => {
  assert.equal(decodeXmlAttribute('&quot;&apos;&lt;&gt;&amp;'), '"\'<> &'.replace(' ',''));
});

test('parseAttributes supports single and double quoted attributes', () => {
  assert.deepEqual(parseAttributes(`Include="A" Condition='x'`), { Include:'A', Condition:'x' });
});

test('parseAttributes rejects duplicate attributes', () => {
  assert.throws(() => parseAttributes(`Include="A" Include="B"`), /duplicate XML attribute Include/);
});

test('extractElements returns paired and self-closing elements in source order', () => {
  const xml = `<Project><PackageReference Include="A"></PackageReference><PackageReference Include="B" /></Project>`;
  assert.deepEqual(extractElements(xml,'PackageReference').map(item=>item.attributes.Include), ['A','B']);
});

test('extractElements ignores commented package declarations', () => {
  const xml = `<Project><!-- <PackageReference Include="Ghost" /> --><PackageReference Include="A" /></Project>`;
  assert.deepEqual(extractElements(xml,'PackageReference').map(item=>item.attributes.Include), ['A']);
});

test('extractPropertyValues returns repeated property values deterministically', () => {
  assert.deepEqual(extractPropertyValues('<A><X> one </X><X>two</X></A>','X'), ['one','two']);
});

for (const valid of ['A','A.B','A-B','A_B','Microsoft.EntityFrameworkCore']) {
  test(`normalizePackageId accepts ${valid}`, () => assert.equal(normalizePackageId(valid), valid));
}

for (const invalid of ['', ' ', '@scope/pkg', '../A', 'A B', 'A/Path', '*']) {
  test(`normalizePackageId rejects ${JSON.stringify(invalid)}`, () => assert.equal(normalizePackageId(invalid), null));
}

for (const version of ['1.0','1.0.0','10.0.12','10.0.652802','1.2.3.4','114.0.0']) {
  test(`stable version accepts ${version}`, () => assert.equal(isConcreteStableVersion(version), true));
}

for (const version of ['', '*','latest','1','1.0.0-preview.1','^1.0.0','$(Version)','1.0.x']) {
  test(`stable version rejects ${JSON.stringify(version)}`, () => assert.equal(isConcreteStableVersion(version), false));
}

test('central catalog accepts exact stable package versions', () => {
  const parsed = parseCentralPackageCatalog(central([['A','1.0.0'],['B','2.3.4']]));
  assert.equal(parsed.findings.length, 0);
  assert.deepEqual(parsed.entries.map(item=>[item.id,item.version]), [['A','1.0.0'],['B','2.3.4']]);
});

test('central catalog requires central management switch exactly once', () => {
  const xml = `<Project><ItemGroup><PackageVersion Include="A" Version="1.0.0" /></ItemGroup></Project>`;
  assert.match(parseCentralPackageCatalog(xml).findings.map(x=>x.code).join(','), /central-management-disabled/);
});

test('central catalog rejects duplicate ids case-insensitively', () => {
  const parsed = parseCentralPackageCatalog(central([['Example','1.0.0'],['example','1.0.1']]));
  assert.ok(parsed.findings.some(item=>item.code==='central-package-duplicate'));
});

test('central catalog rejects missing package version', () => {
  const xml = `<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="A" /></ItemGroup></Project>`;
  assert.ok(parseCentralPackageCatalog(xml).findings.some(item=>item.code==='central-version-missing'));
});

test('central catalog rejects prerelease and property-based versions', () => {
  for (const version of ['1.0.0-preview.1','$(A_VERSION)','*']) {
    const parsed = parseCentralPackageCatalog(central([['A',version]]));
    assert.ok(parsed.findings.some(item=>item.code==='central-version-nonrelease'));
  }
});

test('central catalog supports child Version syntax', () => {
  const xml = `<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="A"><Version>1.2.3</Version></PackageVersion></ItemGroup></Project>`;
  const parsed = parseCentralPackageCatalog(xml);
  assert.equal(parsed.findings.length,0);
  assert.equal(parsed.entries[0].version,'1.2.3');
});

test('central catalog rejects attribute plus child version ambiguity', () => {
  const xml = `<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="A" Version="1.0.0"><Version>1.0.1</Version></PackageVersion></ItemGroup></Project>`;
  assert.ok(parseCentralPackageCatalog(xml).findings.some(item=>item.code==='central-version-ambiguous'));
});

test('project parser accepts central-versioned references', () => {
  const parsed = parseProjectFile(project({packages:['A','B']}),'App.csproj');
  assert.equal(parsed.findings.length,0);
  assert.deepEqual(parsed.packageReferences.map(item=>item.id),['A','B']);
});

test('project parser rejects inline Version attribute', () => {
  const parsed = parseProjectFile(project({packages:['<PackageReference Include="A" Version="1.0.0" />']}),'App.csproj');
  assert.ok(parsed.findings.some(item=>item.code==='package-reference-inline-version'));
});

test('project parser rejects VersionOverride escape hatch', () => {
  const parsed = parseProjectFile(project({packages:['<PackageReference Include="A" VersionOverride="9.9.9" />']}),'App.csproj');
  assert.ok(parsed.findings.some(item=>item.code==='package-reference-version-override'));
});

test('project parser rejects child Version element', () => {
  const parsed = parseProjectFile(project({packages:['<PackageReference Include="A"><Version>1.0.0</Version></PackageReference>']}),'App.csproj');
  assert.ok(parsed.findings.some(item=>item.code==='package-reference-inline-version'));
});

test('project parser ignores explicit Remove references', () => {
  const parsed = parseProjectFile(project({packages:['<PackageReference Remove="A" />']}),'App.csproj');
  assert.equal(parsed.packageReferences.length,0);
});

test('project parser records Update separately from Include', () => {
  const parsed = parseProjectFile(project({packages:['<PackageReference Update="A" PrivateAssets="all" />']}),'App.csproj');
  assert.equal(parsed.packageReferences[0].action,'Update');
});

test('project parser normalizes Windows project reference separators', () => {
  const parsed = parseProjectFile(project({projectReferences:['..\\Business\\Business.csproj']}),'Api/Api.csproj');
  assert.equal(parsed.projectReferences[0].path,'../Business/Business.csproj');
});

test('governance accepts coherent central catalog and project inventory', () => {
  const report = evaluate({
    catalog:[['A','1.0.0'],['B','2.0.0']],
    projects:[{path:'App/App.csproj',xml:project({packages:['A','B']})}],
  });
  assert.equal(report.ok,true,JSON.stringify(report.findings));
  assert.deepEqual(report.summary,{projects:1,centralPackages:2,referencedPackages:2,errors:0,warnings:0});
});

test('governance rejects project reference missing from central catalog', () => {
  const report = evaluate({catalog:[['A','1.0.0']],projects:[{path:'App/App.csproj',xml:project({packages:['B']})}]});
  assert.ok(report.findings.some(item=>item.code==='package-reference-central-version-missing'&&item.package==='B'));
});

test('governance rejects stale central catalog entries', () => {
  const report = evaluate({catalog:[['A','1.0.0'],['Unused','2.0.0']],projects:[{path:'App/App.csproj',xml:project({packages:['A']})}]});
  assert.ok(report.findings.some(item=>item.code==='central-package-unused'&&item.package==='Unused'));
});

test('governance rejects duplicate direct package references in a project', () => {
  const report = evaluate({catalog:[['A','1.0.0']],projects:[{path:'App/App.csproj',xml:project({packages:['A','A']})}]});
  assert.ok(report.findings.some(item=>item.code==='package-reference-duplicate'));
});

test('governance treats package ids case-insensitively', () => {
  const report = evaluate({catalog:[['Example.Package','1.0.0']],projects:[{path:'App/App.csproj',xml:project({packages:['example.package']})}]});
  assert.equal(report.ok,true,JSON.stringify(report.findings));
});

test('governance reports reference usage by project', () => {
  const report = evaluate({catalog:[['A','1.0.0']],projects:[
    {path:'One/One.csproj',xml:project({packages:['A']})},
    {path:'Two/Two.csproj',xml:project({packages:['A']})},
  ]});
  assert.deepEqual(report.usage,[{id:'A',projects:['One/One.csproj','Two/Two.csproj']}]);
});

test('governance validates existing project references', () => {
  const report = evaluate({catalog:[['A','1.0.0']],projects:[
    {path:'App/App.csproj',xml:project({packages:['A'],projectReferences:['../Lib/Lib.csproj']})},
    {path:'Lib/Lib.csproj',xml:project()},
  ]});
  assert.equal(report.ok,true,JSON.stringify(report.findings));
});

test('governance rejects missing project reference target', () => {
  const report = evaluate({projects:[{path:'App/App.csproj',xml:project({packages:['A'],projectReferences:['../Missing/Missing.csproj']})}]});
  assert.ok(report.findings.some(item=>item.code==='project-reference-target-missing'));
});

test('governance rejects project reference escaping repository root', () => {
  const report = evaluate({projects:[{path:'App/App.csproj',xml:project({packages:['A'],projectReferences:['../../Outside.csproj']})}]});
  assert.ok(report.findings.some(item=>item.code==='project-reference-outside-repository'));
});

test('governance rejects project self-reference', () => {
  const report = evaluate({projects:[{path:'App/App.csproj',xml:project({packages:['A'],projectReferences:['App.csproj']})}]});
  assert.ok(report.findings.some(item=>item.code==='project-reference-self'));
});

test('governance fingerprint is deterministic under project input ordering', () => {
  const catalog=[['A','1.0.0'],['B','2.0.0']];
  const one={path:'One/One.csproj',xml:project({packages:['A']})};
  const two={path:'Two/Two.csproj',xml:project({packages:['B']})};
  assert.equal(evaluate({catalog,projects:[one,two]}).fingerprint,evaluate({catalog,projects:[two,one]}).fingerprint);
});

test('governance findings use deterministic ordering', () => {
  const report=evaluate({catalog:[['Unused','1.0.0']],projects:[{path:'Z/Z.csproj',xml:project({packages:['Missing','Missing']})}]});
  assert.deepEqual(report.findings,[...report.findings].sort((a,b)=>a.severity.localeCompare(b.severity)||a.code.localeCompare(b.code)||a.file.localeCompare(b.file)||String(a.package??'').localeCompare(String(b.package??''))||a.message.localeCompare(b.message)));
});

test('markdown report contains gate, fingerprint, findings and catalog', () => {
  const markdown=renderDotnetPackageGovernanceMarkdown(evaluate());
  assert.match(markdown,/# \.NET Package Governance/);
  assert.match(markdown,/Gate: \*\*PASS\*\*/);
  assert.match(markdown,/Fingerprint:/);
  assert.match(markdown,/\| A \| 1\.0\.0 \| 1 \|/);
});

test('markdown escapes pipe characters in finding messages', () => {
  const report=evaluate({projects:[{path:'App/App.csproj',xml:'<Project><ItemGroup><ProjectReference Include="Missing|Pipe.csproj" /></ItemGroup></Project>'}],catalog:[]});
  const markdown=renderDotnetPackageGovernanceMarkdown(report);
  assert.match(markdown,/Missing\\\|Pipe/);
});

test('inventory loader discovers csproj files and ignores excluded directories', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'dotnet-governance-'));
  try {
    await writeFile(path.join(root,'Directory.Packages.props'),central([['A','1.0.0']]));
    await mkdir(path.join(root,'App'),{recursive:true});
    await writeFile(path.join(root,'App','App.csproj'),project({packages:['A']}));
    await mkdir(path.join(root,'obj'),{recursive:true});
    await writeFile(path.join(root,'obj','Ghost.csproj'),project({packages:['Ghost']}));
    const inventory=await loadDotnetPackageInventory(root);
    assert.deepEqual(inventory.projects.map(item=>item.path),['App/App.csproj']);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('inventory loader supports nested project topology', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'dotnet-governance-'));
  try {
    await writeFile(path.join(root,'Directory.Packages.props'),central([['A','1.0.0']]));
    await mkdir(path.join(root,'src','A'),{recursive:true});
    await mkdir(path.join(root,'src','B'),{recursive:true});
    await writeFile(path.join(root,'src','A','A.csproj'),project({packages:['A'],projectReferences:['../B/B.csproj']}));
    await writeFile(path.join(root,'src','B','B.csproj'),project());
    const inventory=await loadDotnetPackageInventory(root);
    const report=evaluateDotnetPackageGovernance(inventory);
    assert.equal(report.ok,true,JSON.stringify(report.findings));
    assert.equal(report.summary.projects,2);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('catalog parser does not interpret commented central versions', () => {
  const xml=`<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><!-- <PackageVersion Include="Ghost" Version="1.0.0" /> --><PackageVersion Include="A" Version="1.0.0" /></ItemGroup></Project>`;
  assert.deepEqual(parseCentralPackageCatalog(xml).entries.map(item=>item.id),['A']);
});

test('project parser does not interpret commented references', () => {
  const xml=`<Project><ItemGroup><!-- <PackageReference Include="Ghost" /> --><PackageReference Include="A" /></ItemGroup></Project>`;
  assert.deepEqual(parseProjectFile(xml,'App.csproj').packageReferences.map(item=>item.id),['A']);
});

test('Update metadata does not make an otherwise stale central package used', () => {
  const report=evaluate({catalog:[['A','1.0.0']],projects:[{path:'App/App.csproj',xml:project({packages:['<PackageReference Update="A" PrivateAssets="all" />']})}]});
  assert.ok(report.findings.some(item=>item.code==='central-package-unused'));
});

test('Remove metadata does not require a central version', () => {
  const report=evaluate({catalog:[],projects:[{path:'App/App.csproj',xml:project({packages:['<PackageReference Remove="Ghost" />']})}]});
  assert.equal(report.ok,true,JSON.stringify(report.findings));
});

test('conditioned Include remains a governed package reference', () => {
  const xml=`<Project><ItemGroup><PackageReference Include="A" Condition="'$(TargetFramework)' == 'net10.0'" /></ItemGroup></Project>`;
  const report=evaluate({catalog:[['A','1.0.0']],projects:[{path:'App/App.csproj',xml}]});
  assert.equal(report.ok,true,JSON.stringify(report.findings));
});

test('catalog rejects invalid package id before stale-package evaluation', () => {
  const xml=`<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="Bad/Id" Version="1.0.0" /></ItemGroup></Project>`;
  const report=evaluateDotnetPackageGovernance({centralXml:xml,projects:[]});
  assert.ok(report.findings.some(item=>item.code==='central-package-id-invalid'));
});

test('report objects expose bounded structured observations instead of source XML', () => {
  const report=evaluate();
  const serialized=JSON.stringify(report);
  assert.equal(serialized.includes('<Project>'),false);
  assert.equal(serialized.includes('<PackageReference'),false);
});
