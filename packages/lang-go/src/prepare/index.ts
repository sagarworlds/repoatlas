export { type GoModFile, parseGoMod } from "./go-mod.ts";
export {
  compareCodeUnits,
  computeGoProjectInfo,
  dirOf,
  type GoModuleInfo,
  type GoPackageTable,
  type GoProjectInfo,
  goPrepare,
  importPathForDir,
  moduleForDir,
  readGoProjectInfo,
  tableFromDirs,
  withDirs,
} from "./project-info.ts";
