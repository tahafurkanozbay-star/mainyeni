function Build-React($root_folder,$project_name,$app_folder,$deploy_file_name,$folder_suffix){

    #$root_folder="C:\Dev\Dev.Shk\Manisa.YapiRiskDenetim"
    #$app_folder="Webclient.admin"

    $target_app_folder= -join($root_folder,"/",$app_folder)

    cd $target_app_folder
    $publish_root_folder= -join("c:\Pub\",$project_name,"-",$folder_suffix)
    
    mkdir $publish_root_folder
    #npm version patch
    npm run build 

    $build_folder= -join($root_folder,"/",$app_folder.ToString(),"/build")

    #$deploy_file_name="adminclient"

    $target_zip_file= -join($deploy_file_name.ToString(),"-",$project_name,"-",$folder_suffix,".zip")

    Compress-Archive -Path $build_folder -DestinationPath $target_zip_file
    
    move $target_zip_file $publish_root_folder
}


function Build-Dotnet($root_folder,$project_name,$app_folder,$deploy_file_name,$folder_suffix){

    #$root_folder="C:\Dev\Dev.Shk\Manisa.YapiRiskDenetim"
    #$app_folder="Webclient.admin"

    $target_app_folder= -join($root_folder,"/",$app_folder)

    cd $target_app_folder
    $publish_root_folder= -join("c:\Pub\",$project_name,"-",$folder_suffix)
    
    mkdir $publish_root_folder
    dotnet publish --os win

    $build_folder= -join($root_folder,"/",$app_folder.ToString(),"/bin/Debug/net6.0/win-x64/publish")

    #$deploy_file_name="adminclient"

    $target_zip_file= -join($deploy_file_name.ToString(),"-",$project_name,"-",$folder_suffix,".zip")

    Compress-Archive -Path $build_folder -DestinationPath $target_zip_file
    
    move $target_zip_file $publish_root_folder
}

$date = Get-Date
$project_folder="C:\Dev\Dev.Shk\ankara-kentrehberi"
$project_name="ankara-kentrehberi"
$folder_suffix = $date.ToString("ddMMyyyy-HHmm")

Write-Output $folder_suffix 

#admin
#Build-React $project_folder $project_name "Webclient.admin" "client-admin" $folder_suffix
#Build-Dotnet $project_folder $project_name "Api.Admin" "api-admin" $folder_suffix

#client
Build-React $project_folder $project_name "Webclient.app" "client-user" $folder_suffix
Build-Dotnet $project_folder $project_name "Api.User" "api-user" $folder_suffix

