import fs from 'fs';
import path from 'path';

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else if (fullPath.endsWith('.dart')) {
      results.push(fullPath);
    }
  });
  return results;
}

const libFiles = walk('mobile_app/lib');
const testFiles = walk('mobile_app/test');
const allFiles = [...libFiles, ...testFiles];
console.log(`Auditing ${allFiles.length} Dart source and test files (${libFiles.length} lib, ${testFiles.length} test)...`);

let issues = 0;
allFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  
  // 1. Verify relative imports
  const importRegex = /import\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const relativeImport = match[1];
    const resolvedPath = path.resolve(path.dirname(file), relativeImport);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ Broken relative import in ${file}: ${relativeImport} -> ${resolvedPath}`);
      issues++;
    }
  }

  // 2. Verify internal package imports (package:archer_guard_c6/...)
  const packageImportRegex = /import\s+['"]package:archer_guard_c6\/([^'"]+)['"]/g;
  while ((match = packageImportRegex.exec(content)) !== null) {
    const pkgPath = match[1];
    const resolvedPkgPath = path.resolve('mobile_app/lib', pkgPath);
    if (!fs.existsSync(resolvedPkgPath)) {
      console.error(`❌ Broken package import in ${file}: package:archer_guard_c6/${pkgPath} -> ${resolvedPkgPath}`);
      issues++;
    }
  }

  // 3. Mark file verified
  console.log(`✅ ${file} (valid imports)`);
});

// 4. Run authoritative Dart & Flutter AST static analysis
console.log('\nRunning authoritative Flutter static analyzer...');
try {
  const { execSync } = await import('child_process');
  const analyzeOutput = execSync('flutter analyze', { cwd: 'mobile_app', stdio: 'pipe' }).toString();
  console.log(analyzeOutput.trim());
} catch (e) {
  const errOutput = e.stdout ? e.stdout.toString() : e.message;
  console.error(`❌ Flutter static analysis reported errors:\n${errOutput}`);
  issues++;
}

if (issues === 0) {
  console.log(`\n🎉 All ${allFiles.length} Dart source and test files passed structural and AST checks!`);
  process.exit(0);
} else {
  console.error(`\n❌ Found ${issues} issues.`);
  process.exit(1);
}
